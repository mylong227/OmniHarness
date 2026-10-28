import type { SessionEvent } from '../ports/runtime/event.ts';
import { Id } from '../util/id.ts';
import type { AcpAuthentication } from './acpAuthentication.ts';
import { ACP_ERROR_INVALID_PARAMS } from './acpProtocol.ts';
import type { AcpSessionUpdate } from './acpProtocol.ts';
import { AcpRequestError } from './acpRequestError.ts';
import type { AcpSessionRegistry, AcpSessionState } from './acpSessionRegistry.ts';
import { AcpValidation } from './acpValidation.ts';

/** 会话生命周期处理器依赖。 */
export interface AcpSessionLifecycleOptions {
  /** 活跃会话表。 */
  readonly registry: AcpSessionRegistry;
  /** 认证状态（requireAuth 门禁）。 */
  readonly auth: AcpAuthentication;
  /** 创建并登记会话运行时（由服务端提供，复用其事件/审批端口装配）。 */
  readonly openSession: (sessionId: string, cwd: string) => Promise<AcpSessionState>;
  /** 推送一条 session/update 通知（由服务端负责关闭位检查）。 */
  readonly sendUpdate: (sessionId: string, update: AcpSessionUpdate) => void;
  /** 收尾某会话挂起的权限请求（close 时按 cancelled 兑现）。 */
  readonly settlePermissions: (permissionIds: readonly number[]) => void;
}

/**
 * ACP 会话生命周期方法集：`session/new|load|list|resume|close`。
 *
 * 从 `AcpServer` 拆出的原因有两条：服务端方法数/行数接近上帝类阈值；这五个方法共享
 * 同一组状态（registry / 认证门禁 / 打开会话 / 权限收尾），集中后才不会出现
 * 「resume 忘了查 closed」「close 忘了收权限」这类跨方法不一致。
 */
export class AcpSessionLifecycle {
  /** 活跃会话表。 */
  private readonly registry: AcpSessionRegistry;
  /** 认证状态。 */
  private readonly auth: AcpAuthentication;
  /** 打开会话的回调。 */
  private readonly openSession: (sessionId: string, cwd: string) => Promise<AcpSessionState>;
  /** 推送 session/update 的回调。 */
  private readonly sendUpdate: (sessionId: string, update: AcpSessionUpdate) => void;
  /** 权限收尾回调。 */
  private readonly settlePermissions: (permissionIds: readonly number[]) => void;

  /**
   * @param options 会话表、认证状态与三个协作者回调。
   */
  public constructor(options: AcpSessionLifecycleOptions) {
    this.registry = options.registry;
    this.auth = options.auth;
    this.openSession = options.openSession;
    this.sendUpdate = options.sendUpdate;
    this.settlePermissions = options.settlePermissions;
  }

  /**
   * session/new：按 Client 给出的 cwd 创建独立会话。
   * @param params 请求参数（cwd 必须是绝对路径）。
   * @returns `{ sessionId }`。
   */
  public async newSession(params: unknown): Promise<unknown> {
    this.auth.require();
    const record = AcpValidation.recordOf(params);
    const cwd = AcpValidation.requireAbsoluteCwd(record);
    const sessionId = Id.id('sess');
    const state = await this.openSession(sessionId, cwd);
    this.registry.touch(state);
    return { sessionId: state.id };
  }

  /**
   * session/load：创建（或复用）会话运行时并回放历史事件。
   *
   * 被 `session/close` 关闭过的 id 允许重新加载（close 只释放活跃资源，不删除会话）；
   * 新建运行时后加载失败时 fail-closed（关闭并上抛）。
   * @param params 请求参数（sessionId / cwd）。
   * @returns 空对象。
   */
  public async loadSession(params: unknown): Promise<unknown> {
    this.auth.require();
    const record = AcpValidation.recordOf(params);
    const sessionId = AcpValidation.requireString(record, 'sessionId');
    const cwd = AcpValidation.requireAbsoluteCwd(record);
    const existing = this.registry.get(sessionId);
    if (existing !== undefined && existing.cwd !== cwd) {
      throw new AcpRequestError(
        `会话 ${sessionId} 的 cwd 不匹配: ${cwd}`,
        ACP_ERROR_INVALID_PARAMS,
      );
    }
    const state = existing ?? (await this.openSession(sessionId, cwd));
    try {
      const events = await state.runtime.load();
      this.registry.forgetClosed(sessionId);
      this.replay(state, events);
      this.registry.touch(state);
      return {};
    } catch (error) {
      if (existing === undefined) this.registry.close(sessionId, this.settlePermissions);
      throw error;
    }
  }

  /**
   * session/list：列出本连接内的活跃会话（只读；可选 cwd 过滤）。
   * @param params 请求参数（cwd 可选，必须是绝对路径）。
   * @returns `{ sessions }`（最近活动时间倒序）。
   */
  public listSessions(params: unknown): unknown {
    this.auth.require();
    const record = AcpValidation.recordOf(params);
    const cwd = AcpValidation.optionalAbsoluteCwd(record);
    const all = this.registry.list(cwd);
    // 2026-10-29：cursor 分页（ACP 规范允许 cursor；此前接受却忽略，客户端无法翻页）。
    // 游标语义 = 上一页最后一条 sessionId；未知游标 fail-closed，不静默回第一页（会让客户端死循环）。
    const cursor = typeof record['cursor'] === 'string' ? record['cursor'] : undefined;
    let start = 0;
    if (cursor !== undefined && cursor !== '') {
      const index = all.findIndex((session) => session.sessionId === cursor);
      if (index < 0) {
        throw new AcpRequestError(
          `session/list cursor 不存在: ${cursor}`,
          ACP_ERROR_INVALID_PARAMS,
        );
      }
      start = index + 1;
    }
    const pageSize = 50;
    const page = all.slice(start, start + pageSize);
    const last = page[page.length - 1];
    const nextCursor =
      start + pageSize < all.length && last !== undefined ? last.sessionId : undefined;
    return {
      sessions: page,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  /**
   * session/resume：复用既有会话继续 prompt（不回放历史）。
   *
   * 活跃会话直接返回；持久化但未激活的会话先恢复运行时并读一次历史（空历史 = 不存在，
   * fail-closed）。被显式 close 的 id 直接拒绝，避免「关闭后又被静默复活」。
   * @param params 请求参数（sessionId / cwd）。
   * @returns 空对象。
   */
  public async resumeSession(params: unknown): Promise<unknown> {
    this.auth.require();
    const record = AcpValidation.recordOf(params);
    const sessionId = AcpValidation.requireString(record, 'sessionId');
    const cwd = AcpValidation.requireAbsoluteCwd(record);
    if (this.registry.wasClosed(sessionId)) {
      throw new AcpRequestError(`会话已关闭: ${sessionId}`, ACP_ERROR_INVALID_PARAMS);
    }
    const existing = this.registry.get(sessionId);
    if (existing !== undefined) {
      if (existing.cwd !== cwd) {
        throw new AcpRequestError(
          `会话 ${sessionId} 的 cwd 不匹配: ${cwd}`,
          ACP_ERROR_INVALID_PARAMS,
        );
      }
      this.registry.touch(existing);
      return {};
    }
    const state = await this.openSession(sessionId, cwd);
    let events: readonly SessionEvent[];
    try {
      events = await state.runtime.load();
    } catch (error) {
      this.registry.close(sessionId, this.settlePermissions);
      throw error;
    }
    if (this.registry.wasClosed(sessionId)) {
      // 并发的 session/close 在 load 期间生效：不得把已关闭的会话当作恢复成功。
      this.registry.close(sessionId, this.settlePermissions);
      throw new AcpRequestError(`会话已关闭: ${sessionId}`, ACP_ERROR_INVALID_PARAMS);
    }
    if (events.length === 0) {
      this.registry.close(sessionId, this.settlePermissions);
      throw new AcpRequestError(`未知会话: ${sessionId}`, ACP_ERROR_INVALID_PARAMS);
    }
    this.registry.touch(state);
    return {};
  }

  /**
   * session/close：取消在跑回合、释放 mapper/运行时、移除会话；重复 close 幂等。
   * @param params 请求参数（sessionId）。
   * @returns 空对象。
   */
  public closeSession(params: unknown): unknown {
    const record = AcpValidation.recordOf(params);
    const sessionId = AcpValidation.requireString(record, 'sessionId');
    const state = this.registry.close(sessionId, this.settlePermissions);
    if (state !== undefined) return {};
    if (this.registry.wasClosed(sessionId)) return {};
    throw new AcpRequestError(`未知会话: ${sessionId}`, ACP_ERROR_INVALID_PARAMS);
  }

  /**
   * 回放历史事件（session/load 专用）；回放标志让 user 消息也作为 `user_message_chunk` 发出。
   * @param state 会话状态。
   * @param events 历史事件。
   * @returns 无返回值。
   */
  private replay(state: AcpSessionState, events: readonly SessionEvent[]): void {
    for (const event of events) {
      for (const update of state.mapper.map(event, { replay: true })) {
        this.sendUpdate(state.id, update);
      }
    }
  }
}
