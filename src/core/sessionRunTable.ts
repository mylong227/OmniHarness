import type { CancellationToken } from './loop/cancellationToken.ts';
import type { EventPersister } from './loop/eventPersister.ts';
import type { SessionEvent } from '../ports/runtime/event.ts';

/** 在跑会话的登记项（取消令牌、持久化器、回卷器、内存事件读取）。 */
export interface SessionRunEntry {
  readonly cancel: CancellationToken;
  readonly persister: EventPersister;
  readonly rewinder: (size: number) => Promise<void>;
  /** 本会话内存事实源的事件快照读取器（零副作用）。 */
  readonly events: () => readonly SessionEvent[];
}

/**
 * 在跑会话表（2026-10-29 从 `Agent` 抽出，给 steering 入口腾体量）。
 *
 * 只做键值登记与并发防御；取消/持久化语义仍由调用方决定。
 */
export class SessionRunTable {
  /** 会话 id → 登记项（插入序）。 */
  private readonly entries = new Map<string, SessionRunEntry>();

  /**
   * 取登记项。
   * @param sessionId 会话 id。
   * @returns 登记项；不在跑时 undefined。
   */
  public get(sessionId: string): SessionRunEntry | undefined {
    return this.entries.get(sessionId);
  }

  /**
   * 会话是否在跑。
   * @param sessionId 会话 id。
   * @returns 是否已登记。
   */
  public has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /**
   * 登记/覆盖。
   * @param sessionId 会话 id。
   * @param entry 登记项。
   * @returns 无返回值。
   */
  public set(sessionId: string, entry: SessionRunEntry): void {
    this.entries.set(sessionId, entry);
  }

  /**
   * 移除。
   * @param sessionId 会话 id。
   * @returns 无返回值。
   */
  public delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /**
   * 仅当当前登记项仍是 `entry` 时移除（防止先结束的回合清掉后启动的会话）。
   * @param sessionId 会话 id。
   * @param entry 期望的登记项。
   * @returns 是否移除。
   */
  public deleteIf(sessionId: string, entry: SessionRunEntry): boolean {
    if (this.entries.get(sessionId) !== entry) return false;
    this.entries.delete(sessionId);
    return true;
  }

  /**
   * 在跑会话 id。
   * @returns id 数组（插入序）。
   */
  public ids(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 全部登记项。
   * @returns 登记项数组（插入序）。
   */
  public all(): SessionRunEntry[] {
    return [...this.entries.values()];
  }
}
