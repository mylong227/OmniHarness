/**
 * 会话回退服务：把持久化事件流截断到指定事件（**重生成的服务端真回退**）。
 *
 * 为什么必须有服务端回退：前端 `regenerate()` 此前只截断**视图层**事件列表再重发，
 * 服务端 jsonl 里被顶掉的那一轮仍在 ⇒ 下一回合的模型上下文照旧包含旧回答（"重生成"看到的
 * 是"接着旧答案"），刷新页面后旧回答还会复现。这里把「回退」做成对**唯一事实源**的操作。
 *
 * 安全规则（全部 fail-closed，绝不静默半截）：
 * - 会话不存在 / `keepEventId` 不在事件流里 ⇒ 拒绝（返回原因，不做任何写入）；
 * - 有回合在跑 ⇒ 拒绝（避免「回合写盘」与「回退写盘」互相覆盖）；
 * - 无需截断（keepEventId 已是末条）⇒ 不写盘，如实回报 `dropped: 0`。
 */
import type { SessionEvent } from '../../ports/runtime/event.js';

/** 回退依赖（注入以避免直接持有存储/运行时）。 */
export interface SessionRewindDeps {
  /** 读取会话事件（与 `threads.get` 同一事实源）。 */
  readonly replay: (sessionId: string) => Promise<readonly SessionEvent[]>;
  /** 写回截断后的事件流。 */
  readonly save: (sessionId: string, events: readonly SessionEvent[]) => Promise<void>;
  /** 该会话是否有回合在跑。 */
  readonly isRunning: (sessionId: string) => boolean;
}

/** 回退结果：成功给出保留/丢弃条数，失败给出可读原因。 */
export type SessionRewindOutcome =
  | { readonly ok: true; readonly kept: number; readonly dropped: number }
  | { readonly ok: false; readonly error: string };

/** 会话回退服务。 */
export class SessionRewindService {
  /** 依赖集合。 */
  private readonly deps: SessionRewindDeps;

  /**
   * @param deps 回退依赖（读 / 写 / 运行态判定）。
   */
  public constructor(deps: SessionRewindDeps) {
    this.deps = deps;
  }

  /**
   * 截断会话事件流：**保留** `keepEventId` 及其之前的全部事件，丢弃其后的事件。
   *
   * @param sessionId 会话 ID。
   * @param keepEventId 保留到哪条事件（含）。
   * @returns 成功给出 `kept`/`dropped`；失败给出原因（不抛错，便于 RPC 直接回传）。
   */
  public async rewind(sessionId: string, keepEventId: string): Promise<SessionRewindOutcome> {
    if (sessionId.trim() === '') {
      return { ok: false, error: '缺少 sessionId' };
    }
    if (keepEventId.trim() === '') {
      return { ok: false, error: '缺少 keepEventId' };
    }
    if (this.deps.isRunning(sessionId)) {
      return { ok: false, error: '该会话有回合正在运行：请先中止再回退' };
    }
    const events = await this.deps.replay(sessionId);
    if (events.length === 0) {
      return { ok: false, error: `会话不存在或没有事件：${sessionId}` };
    }
    const index = events.findIndex((e) => e.id === keepEventId);
    if (index < 0) {
      return { ok: false, error: `事件不在该会话中：${keepEventId}` };
    }
    const kept = events.slice(0, index + 1);
    const dropped = events.length - kept.length;
    if (dropped === 0) {
      return { ok: true, kept: kept.length, dropped: 0 };
    }
    await this.deps.save(sessionId, kept);
    return { ok: true, kept: kept.length, dropped };
  }
}
