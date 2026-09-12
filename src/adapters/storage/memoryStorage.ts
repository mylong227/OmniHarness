import type { SessionEvent } from '../../ports/event.js';
import type { StoragePort } from '../../ports/storage.js';

/** 内存存储适配器：会话事件仅存于进程内（不落盘）。 */
export class MemoryStorage implements StoragePort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'，不落盘）。 */
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
