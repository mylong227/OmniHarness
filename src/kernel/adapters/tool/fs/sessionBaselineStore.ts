/**
 * 会话基线文本存储（三方合并的「共同祖先」）。
 *
 * 为什么需要：`FileContentLedger` 原来只存内容哈希（能判断"变了"，但无法回答"哪里变了"）。
 * 真正的三方合并 `base + ours + theirs` 需要 base 的**全文**。这里按 `(路径, 会话)` 保存
 * 最近一次读/写到的工作副本，并有界（单条 ≤512 KiB、全局 ≤16 MiB、最多 4096 条）：
 * 超限只丢弃基线，不丢正确性——调用方会退回「拒绝并重读」的保守路径。
 */
export interface SessionBaselineStoreOptions {
  /** 全局字节上限（默认 16 MiB）。 */
  readonly maxBytes?: number | undefined;
  /** 单条文本字节上限（默认 512 KiB；超过则不保存基线）。 */
  readonly maxEntryBytes?: number | undefined;
  /** 最多条目数（默认 4096；超出按插入序淘汰）。 */
  readonly maxEntries?: number | undefined;
}

/** 单条基线条目。 */
interface BaselineEntry {
  readonly path: string;
  readonly owner: string;
  readonly text: string;
  readonly bytes: number;
}

/** 会话基线文本的有界 LRU 存储。 */
export class SessionBaselineStore {
  /** key（path + NUL + owner）→ 条目；Map 插入序即 LRU 序。 */
  private readonly entries = new Map<string, BaselineEntry>();
  /** 当前总字节数。 */
  private bytes = 0;
  /** 全局字节上限。 */
  private readonly maxBytes: number;
  /** 单条字节上限。 */
  private readonly maxEntryBytes: number;
  /** 条目数上限。 */
  private readonly maxEntries: number;

  /**
   * @param options 容量参数。
   */
  public constructor(options: SessionBaselineStoreOptions = {}) {
    this.maxBytes = Math.max(1, options.maxBytes ?? 16 * 1024 * 1024);
    this.maxEntryBytes = Math.max(1, options.maxEntryBytes ?? 512 * 1024);
    this.maxEntries = Math.max(1, options.maxEntries ?? 4_096);
  }

  /**
   * 记录一份基线文本（超过单条上限则丢弃已有基线）。
   * @param path 绝对路径。
   * @param owner 会话 id。
   * @param text 基线全文。
   * @returns 无返回值。
   */
  public set(path: string, owner: string, text: string): void {
    const key = SessionBaselineStore.keyOf(path, owner);
    this.removeKey(key);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxEntryBytes) return;
    this.entries.set(key, { path, owner, text, bytes });
    this.bytes += bytes;
    this.evict();
  }

  /**
   * 读取基线文本（命中即提升为最近使用）。
   * @param path 绝对路径。
   * @param owner 会话 id。
   * @returns 基线全文；没有/已被淘汰时 undefined。
   */
  public get(path: string, owner: string): string | undefined {
    const key = SessionBaselineStore.keyOf(path, owner);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // 命中即移到队尾（LRU）；Map 的删除+重插是 O(1)。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.text;
  }

  /**
   * 删除某路径的所有会话基线（文件被删除/被 shell 改动后保守失效）。
   * @param path 绝对路径。
   * @returns 无返回值。
   */
  public deletePath(path: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.path === path) this.removeKey(key);
    }
  }

  /**
   * 当前占用字节数（测试/诊断）。
   * @returns 字节数。
   */
  public sizeBytes(): number {
    return this.bytes;
  }

  /**
   * 当前条目数（测试/诊断）。
   * @returns 条目数。
   */
  public size(): number {
    return this.entries.size;
  }

  /**
   * 删除一个 key 并扣减字节。
   * @param key 内部键。
   * @returns 无返回值。
   */
  private removeKey(key: string): void {
    const previous = this.entries.get(key);
    if (previous === undefined) return;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - previous.bytes);
  }

  /**
   * 按 LRU 淘汰直到回到预算内。
   * @returns 无返回值。
   */
  private evict(): void {
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.removeKey(oldest);
    }
  }

  /**
   * 组合键（用 NUL 避免路径/会话 id 里的普通字符冲突）。
   * @param path 绝对路径。
   * @param owner 会话 id。
   * @returns 内部键。
   */
  private static keyOf(path: string, owner: string): string {
    return `${path}\u0000${owner}`;
  }
}
