import type { SessionEvent } from '../../ports/event.js';
import type { StoragePort } from '../../ports/storage.js';

/** 内存存储适配器：会话事件仅存于进程内（不落盘）。 */
export class MemoryStorage implements StoragePort {
  public readonly name = 'memory';

  private readonly buckets = new Map<string, SessionEvent[]>();

  /** 保存会话事件。 */
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    this.buckets.set(sessionId, [...events]);
  }

  /** 加载会话事件（不存在返回空）。 */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    return this.buckets.get(sessionId) ?? [];
  }
}
