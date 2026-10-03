import type { SessionEvent } from '../../ports/runtime/event.js';
import type { StoragePort } from '../../ports/memory/storage.js';

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

  /**
   * **追加**会话事件（G7）：只把 `fromCount` 之后的尾部推入桶，不再整桶覆盖。
   *
   * 前缀校验：桶内条数必须等于调用方声明。语义**故意不做"尽力追加"**——内存后端看似不会错位，
   * 但契约一致性比省一次判断重要：若这里悄悄容忍，调用方的 `lastSavedCount` 与实际内容一旦分叉，
   * 错位会一路带到落盘后端。
   * @param sessionId 会话标识（桶键）。
   * @param events 完整事件列表（只追加 `fromCount` 之后的部分）。
   * @param fromCount 调用方声明的"桶内已有条数"。
   * @returns 无返回值；校验失败时抛错。
   */
  public async append(
    sessionId: string,
    events: readonly SessionEvent[],
    fromCount: number,
  ): Promise<void> {
    const bucket = this.buckets.get(sessionId) ?? [];
    if (bucket.length !== fromCount) {
      throw new Error(
        `memory 追加前置校验失败：桶内条数与声明不符（桶内=${String(bucket.length)}，声明=${String(fromCount)}）`,
      );
    }
    for (const event of events.slice(fromCount)) {
      bucket.push(event);
    }
  }
}
