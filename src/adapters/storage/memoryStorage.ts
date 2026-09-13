import type { SessionEvent } from '../../ports/event.js';
import type { StoragePort } from '../../ports/storage.js';

/** 内存存储适配器：会话事件仅存于进程内（不落盘）。 */
export class MemoryStorage implements StoragePort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'，不落盘）。 */
  public readonly name = 'memory';

  /** 会话事件桶：sessionId → 事件数组（整存整取，进程退出即丢失）。 */
  private readonly buckets = new Map<string, SessionEvent[]>();

  /** 保存会话事件。
   * @param sessionId 会话标识（桶键）。
   * @param events 完整事件列表（浅拷贝后整体覆盖旧值）。
   
 * @returns 无返回值。
*/
  public async save(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    this.buckets.set(sessionId, [...events]);
  }

  /** 加载会话事件（不存在返回空）。
   * @param sessionId 会话标识。
   * @returns 保存时的事件数组；会话不存在时为空数组。
   */
  public async load(sessionId: string): Promise<readonly SessionEvent[]> {
    return this.buckets.get(sessionId) ?? [];
  }
}
