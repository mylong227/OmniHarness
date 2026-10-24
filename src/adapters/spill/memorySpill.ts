import type { SpillHandle, SpillPort } from '../../ports/memory/spill.ts';
import { Id } from '../../util/id.ts';

/** 内存外溢默认总字节上限：64 MiB。 */
export const DEFAULT_MEMORY_SPILL_MAX_BYTES = 64 * 1024 * 1024;

/** 内存外溢选项。 */
export interface MemorySpillOptions {
  /** 总字节上限（缺省 64 MiB；`0`/负数 = 不限制，供测试/长期驻留场景）。 */
  readonly maxBytes?: number | undefined;
}

/**
 * @beta
 * 内存外溢端口（测试/临时场景）：内容随进程生命周期存在，不落盘。
 *
 * 2026-10-23：原实现是无界 `Map`，会话里反复外溢会让进程内存单调增长；现在按总字节
 * LRU 淘汰（至少保留最新一份，否则刚写的内容立刻不可读）。
 */
export class MemorySpill implements SpillPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'，不落盘）。 */
  public readonly name = 'memory';

  /** 外溢内容表：句柄 id → 原文（按插入顺序做 LRU）。 */
  private readonly store = new Map<string, string>();

  /** 当前内容总字节数。 */
  private totalBytes = 0;

  /** 总字节上限（0 = 不限制）。 */
  private readonly maxBytes: number;

  /**
   * @param options 总字节上限（缺省 {@link DEFAULT_MEMORY_SPILL_MAX_BYTES}）。
   */
  public constructor(options: MemorySpillOptions = {}) {
    const value = options.maxBytes;
    this.maxBytes =
      value !== undefined && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : DEFAULT_MEMORY_SPILL_MAX_BYTES;
  }

  /** 保存内容并返回句柄。
   * @param content 待外溢的完整文本内容。
   * @param _sessionId 会话标识（当前实现未参与存储键，保留参数以符合端口签名）。
   * @returns 外溢句柄（全局唯一 id 与内容字节数）。
   */
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    const bytes = Buffer.byteLength(content, 'utf8');
    const handle = { id: Id.id('spill'), bytes };
    this.store.set(handle.id, content);
    this.totalBytes += bytes;
    this.evict();
    return handle;
  }

  /** 读回内容（命中时续命到 LRU 尾部）。
   * @param spillId 外溢句柄 id。
   * @returns 存储的原始文本；id 不存在时为 undefined。
   */
  public async read(spillId: string): Promise<string | undefined> {
    const content = this.store.get(spillId);
    if (content === undefined) return undefined;
    this.store.delete(spillId);
    this.store.set(spillId, content);
    return content;
  }

  /** 当前条目数与总字节数（观测/判据用）。
   * @returns `{ entries, bytes }`。
   */
  public stats(): { readonly entries: number; readonly bytes: number } {
    return { entries: this.store.size, bytes: this.totalBytes };
  }

  /** 按总字节上限淘汰最旧条目（至少保留最新一份）。
   * @returns 无返回值。
   */
  private evict(): void {
    if (this.maxBytes <= 0) return;
    while (this.totalBytes > this.maxBytes && this.store.size > 1) {
      const oldest = this.store.keys().next();
      if (oldest.done === true) break;
      const content = this.store.get(oldest.value);
      this.store.delete(oldest.value);
      if (content !== undefined) this.totalBytes -= Buffer.byteLength(content, 'utf8');
    }
  }
}
