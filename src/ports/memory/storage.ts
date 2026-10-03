import type { SessionEvent } from '../runtime/event.js';

/**
 * 存储端口：会话事件持久化的统一插口（可换后端：内存/文件/SQLite/云）。
 */
export interface StoragePort {
  readonly name: string;
  /** 后端物理位置（文件目录 / SQLite 库路径）；内存等无落盘后端为 undefined。 */
  readonly location?: string;
  save(sessionId: string, events: readonly SessionEvent[]): Promise<void>;
  load(sessionId: string): Promise<readonly SessionEvent[]>;
  /**
   * **追加**会话事件（可选通道；未实现即自动回落 {@link save} 全量写）。
   *
   * ## 为什么需要它（G7，2026-10-03 第八轮）
   *
   * 事件溯源架构主张"只追加"，但三个适配器原先都只有全量 `save`：`jsonl` 整文件 tmp+rename、
   * `sqlite` 一个事务里 `DELETE` 全桶 + 逐条 `INSERT`。而 `EventPersister` **每步**都落一次盘
   * ⇒ 单次成本随事件数**线性**增长，长会话累计写入达到 `size_N × 步数 / 2`（看板 §8.3 实测：200 条
   * ≈28 ms/89 KB、3,200 条 ≈41 ms/1.6 MB、12,800 条 ≈139 ms/6.5 MB）。
   *
   * ## 契约（fail-closed，实现方必须遵守）
   *
   * 1. **只追加不覆盖**：只允许把 `events[fromCount..]` 写到既有内容的**后面**，绝不重写前缀；
   * 2. **写入前校验前缀**：调用方声明"后端本应有 `fromCount` 条"。实现**必须**核对这一点
   *    （廉价方式即可：上次成功写的字节数 / `SELECT COUNT(*)`），不符即**抛错**。
   *    绝不允许"尽力追加"：一次错位追加会让历史永久错乱，而存档表面看起来仍然正常。
   * 3. 抛错即触发调用方回退全量 `save`，故**宁抛勿猜**。
   * @param sessionId 会话标识。
   * @param events 完整事件列表（实现只取 `fromCount` 之后的部分）。
   * @param fromCount 调用方声明的"后端已有条数"。
   * @returns 无返回值；前缀校验失败或写入失败时抛错。
   */
  append?(sessionId: string, events: readonly SessionEvent[], fromCount: number): Promise<void>;
}
