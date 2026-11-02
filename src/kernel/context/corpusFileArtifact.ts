import type { SymbolNode } from './repoMap/repoMap.ts';

/**
 * 单文件**解析产物**（增量重建的最小复用单元）。
 *
 * 存在理由（2026-10-03，`docs/PROJECT_BOARD.md` §3.1 遗留项）：本仓语料实测
 * 「读盘 + 分词 + 抽符号」占一次全量索引的 **3.9s / 7.2s**（3223 文件 / 33.5 MB），
 * 而写类工具之后的改动通常只涉及一两个文件。把这些产物按**内容哈希**留在缓存里，
 * 未变的文件就不必重新分词与抽符号——判据仍是内容本身（不是 mtime），故事实来源不变。
 *
 * 2026-10-23 内存压缩：`fileDoc`/`symbolDocs` 从「字符串数组」改为**单个分隔串**。
 * 1.7M 个短 token 字符串的堆开销（对象头 + 数组槽）远大于其字符本身；一个文件/符号
 * 只留一个串，增量时才解码成数组（临时数组在 `setDocument` 后即可回收）。
 */
export interface CorpusFileArtifact {
  /** 相对 POSIX 路径（与 `corpus.files[i].rel` 同源）。 */
  readonly rel: string;
  /** `content` 的 SHA-1（内容身份；与 mtime 无关）。 */
  readonly hash: string;
  /** 文件级 BM25 文档词项（编码串；用 `CorpusFileArtifactCodec.decode` 还原）。 */
  readonly fileDoc: string;
  /** `corpus.files[i].tokens` 口径的计数（**不带路径扩展**）。 */
  readonly tokenCount: number;
  /** 该文件的符号（按 `RepoMap.extractSymbols` 顺序）。 */
  readonly symbols: readonly SymbolNode[];
  /** 每个符号的 BM25 文档词项（编码串；与 `symbols` 同序）。 */
  readonly symbolDocs: readonly string[];
  /** 该文件首个符号在 `corpus.symbols` 中的下标（符号数变化时全部后继文件会平移）。 */
  readonly symbolStart: number;
}
