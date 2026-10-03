import type { SymbolNode } from './repoMap/repoMap.js';

/**
 * 单个文件的**解析产物**（增量重建的最小复用单元）。
 *
 * 存在理由（2026-10-03，`docs/PROJECT_BOARD.md` §3.1 遗留项）：本仓语料实测
 * 「读盘 + 分词 + 抽符号」占一次全量索引的 **3.9s / 7.2s**（3223 文件 / 33.5 MB），
 * 而写类工具之后的改动通常只涉及一两个文件。把这些产物按**内容哈希**留在缓存里，
 * 未变的文件就不必重新分词与抽符号——判据仍是内容本身（不是 mtime），故事实来源不变。
 *
 * 字段全部是**可直接重放**的量：用它们能组装出与全量索引逐位一致的语料
 * （由 `tests/unit/corpusIncremental.test.ts` 对拍钉住）。
 */
export interface CorpusFileArtifact {
  /** 相对 POSIX 路径（与 `corpus.files[i].rel` 同源）。 */
  readonly rel: string;
  /** `content` 的 SHA-1（内容身份；与 mtime 无关）。 */
  readonly hash: string;
  /** 文件级 BM25 文档词项（`tokenize(text)` ∪ 路径扩展词，与全量路径同一构造口径）。 */
  readonly fileDoc: string[];
  /** `corpus.files[i].tokens` 口径的计数（**不带路径扩展**，见 `indexCorpus` 的 fileRecords）。 */
  readonly tokenCount: number;
  /** 该文件的符号（按 `RepoMap.extractSymbols` 顺序）。 */
  readonly symbols: readonly SymbolNode[];
  /** 每个符号的 BM25 文档词项（`tokenizeExpandedCounted(name kind signature file)`）。 */
  readonly symbolDocs: string[][];
  /** 该文件首个符号在 `corpus.symbols` 中的下标（符号数变化时全部后继文件会平移）。 */
  readonly symbolStart: number;
}
