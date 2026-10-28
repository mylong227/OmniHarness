import type { ApprovalDecision } from '../ports/runtime/approval.ts';
import { AcpEventMapper } from './acpEventMapper.ts';
import { ACP_ERROR_INVALID_PARAMS } from './acpProtocol.ts';
import type { AcpAuthIdentity, AcpSessionInfo } from './acpProtocol.ts';
import { AcpRequestError } from './acpRequestError.ts';
import type { AcpSessionRuntime } from './agentAcpSession.ts';

/** 关闭会话 id 的记忆上限（超过后按插入顺序淘汰；只影响「重复 close 幂等」的判定范围）。 */
const CLOSED_SESSION_MEMORY_LIMIT = 1024;

/** 一条活跃会话的运行时状态。 */
export interface AcpSessionState {
  /** 会话 id。 */
  readonly id: string;
  /** 工作目录。 */
  readonly cwd: string;
  /** 运行时（真实 Agent 或测试替身）。 */
  readonly runtime: AcpSessionRuntime;
  /** 事件 → ACP 更新映射器。 */
  readonly mapper: AcpEventMapper;
  /** 本轮是否收到过 session/cancel。 */
  cancelRequested: boolean;
  /** 是否有 prompt 回合在跑。 */
  busy: boolean;
  /** 会话标题（首轮 prompt 首行，最多 80 字符）。 */
  title?: string | undefined;
  /** 最近活动时间（ISO 8601）。 */
  updatedAt: string;
  /**
   * 会话级「总是允许 / 总是拒绝」记忆（工具名 → 决策）。
   *
   * ACP 的 `allow_always` / `reject_always` 语义是「本会话内不再问」——此前服务端
   * 把四个选项都当一次性结果，选了「总是允许」下一轮同工具仍然弹窗（审计 #12）。
   * 记忆随会话对象一起销毁（close / 连接断开），不落盘、不跨会话。
   */
  readonly alwaysDecisions: Map<string, ApprovalDecision>;
  /** 认证成功后的身份（logout / 重新 authenticate 时更新）。 */
  identity?: AcpAuthIdentity | undefined;
}

/**
 * ACP 活跃会话表 + 生命周期簿记（**单连接**）。
 *
 * 从 `AcpServer` 抽出的原因：方法数已接近上帝类阈值，而「会话表 / 权限请求归属 /
 * 已关闭 id」三者是同一份可变状态，分散在两个类里必然出现「close 删了 sessions 却漏了权限 id」
 * 这类不一致。集中后 `AcpServer` 只负责协议分发。
 */
export class AcpSessionRegistry {
  /** 活跃会话。 */
  private readonly sessions = new Map<string, AcpSessionState>();
  /** 会话 → 该会话挂起的权限请求 id（取消 / 关闭时逐一收尾）。 */
  private readonly permissionIds = new Map<string, Set<number>>();
  /** 已显式 close 的会话 id（重复 close 幂等；resume 对它们 fail-closed）。 */
  private readonly closed = new Set<string>();

  /**
   * 登记一条会话。
   * @param state 会话状态。
   * @returns 无返回值。
   */
  public add(state: AcpSessionState): void {
    this.sessions.set(state.id, state);
  }

  /**
   * 取会话（不存在返回 undefined）。
   * @param sessionId 会话 id。
   * @returns 会话状态。
   */
  public get(sessionId: string): AcpSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 取会话；不存在即按非法参数拒绝。
   * @param sessionId 会话 id。
   * @returns 会话状态。
   * @throws AcpRequestError 会话不存在时抛出（-32602）。
   */
  public require(sessionId: string): AcpSessionState {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      throw new AcpRequestError(`未知会话: ${sessionId}`, ACP_ERROR_INVALID_PARAMS);
    }
    return state;
  }

  /**
   * 关闭会话：取消在跑回合、释放 mapper 与运行时、收尾挂起权限请求、移出会话表。
   *
   * **幂等**：已关闭 / 不存在的会话返回 undefined，由调用方用 {@link wasClosed} 区分
   * 「重复 close」与「从未见过」。
   * @param sessionId 会话 id。
   * @param settlePermissions 收尾该会话挂起权限请求的回调（取消语义）。
   * @returns 被关闭的会话状态；不在活跃表中时返回 undefined。
   */
  public close(
    sessionId: string,
    settlePermissions: (permissionIds: readonly number[]) => void,
  ): AcpSessionState | undefined {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return undefined;
    state.cancelRequested = true;
    state.runtime.cancel();
    const ids = this.permissionIds.get(sessionId);
    if (ids !== undefined) {
      settlePermissions([...ids]);
      this.permissionIds.delete(sessionId);
    }
    state.runtime.dispose?.();
    state.mapper.reset();
    this.sessions.delete(sessionId);
    this.rememberClosed(sessionId);
    return state;
  }

  /**
   * 关闭全部活跃会话（传输关闭 / 服务端主动关闭时调用）。
   * @param settlePermissions 收尾权限请求的回调。
   * @returns 无返回值。
   */
  public shutdown(settlePermissions: (permissionIds: readonly number[]) => void): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId, settlePermissions);
    }
  }

  /**
   * 该 id 是否被本连接显式关闭过。
   * @param sessionId 会话 id。
   * @returns 关闭过为 true。
   */
  public wasClosed(sessionId: string): boolean {
    return this.closed.has(sessionId);
  }

  /**
   * 忘记关闭记录（session/load 允许重新打开被 close 的会话后调用）。
   * @param sessionId 会话 id。
   * @returns 无返回值。
   */
  public forgetClosed(sessionId: string): void {
    this.closed.delete(sessionId);
  }

  /**
   * 列出活跃会话元数据（只读；可按 cwd 过滤）。
   * @param cwd 可选的工作目录过滤（绝对路径）。
   * @returns 会话元数据（最近活动时间倒序，同时间按 id 升序）。
   */
  public list(cwd?: string): readonly AcpSessionInfo[] {
    const states = [...this.sessions.values()]
      .filter((state) => cwd === undefined || state.cwd === cwd)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
    return states.map((state) => ({
      sessionId: state.id,
      cwd: state.cwd,
      updatedAt: state.updatedAt,
      ...(state.title !== undefined ? { title: state.title } : {}),
    }));
  }

  /**
   * 刷新最近活动时间。
   * @param state 会话状态。
   * @returns 无返回值。
   */
  public touch(state: AcpSessionState): void {
    state.updatedAt = new Date().toISOString();
  }

  /**
   * 记录会话标题（只记首轮；空标题忽略）。
   * @param state 会话状态。
   * @param title 候选标题。
   * @returns 无返回值。
   */
  public setTitle(state: AcpSessionState, title: string): void {
    if (state.title !== undefined) return;
    const text = title.trim().slice(0, 80);
    if (text !== '') state.title = text;
  }

  /**
   * 取该会话挂起的权限请求 id。
   * @param sessionId 会话 id。
   * @returns 权限请求 id 数组（无挂起时为空数组）。
   */
  public permissionIdsOf(sessionId: string): readonly number[] {
    return [...(this.permissionIds.get(sessionId) ?? [])];
  }

  /**
   * 登记一条挂起权限请求。
   * @param sessionId 会话 id。
   * @param permissionId 权限请求 id。
   * @returns 无返回值。
   */
  public addPermissionId(sessionId: string, permissionId: number): void {
    const ids = this.permissionIds.get(sessionId) ?? new Set<number>();
    ids.add(permissionId);
    this.permissionIds.set(sessionId, ids);
  }

  /**
   * 移除一条已收尾的权限请求（集合空时删除该会话的条目）。
   * @param sessionId 会话 id。
   * @param permissionId 权限请求 id。
   * @returns 无返回值。
   */
  public removePermissionId(sessionId: string, permissionId: number): void {
    const ids = this.permissionIds.get(sessionId);
    if (ids === undefined) return;
    ids.delete(permissionId);
    if (ids.size === 0) this.permissionIds.delete(sessionId);
  }

  /**
   * 把认证身份写到全部活跃会话（authenticate 成功时调用）。
   * @param identity 认证身份。
   * @returns 无返回值。
   */
  public applyIdentity(identity: AcpAuthIdentity): void {
    for (const state of this.sessions.values()) state.identity = identity;
  }

  /**
   * 清除全部活跃会话上的认证身份（logout 时调用）。
   * @returns 无返回值。
   */
  public clearIdentity(): void {
    for (const state of this.sessions.values()) delete state.identity;
  }

  /**
   * 记住已关闭的 id（超过上限时淘汰最早的记录）。
   * @param sessionId 会话 id。
   * @returns 无返回值。
   */
  private rememberClosed(sessionId: string): void {
    this.closed.add(sessionId);
    if (this.closed.size <= CLOSED_SESSION_MEMORY_LIMIT) return;
    const oldest = this.closed.values().next().value;
    if (oldest !== undefined) this.closed.delete(oldest);
  }
}
