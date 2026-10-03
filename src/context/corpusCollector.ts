import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CorpusFileParser } from './corpusFileParser.js';
import type { CorpusFileArtifact } from './corpusFileArtifact.js';
import type { SymbolNode } from './repoMap/repoMap.js';

/**
 * 单文件记录（与 `ContextEngine` 内部 `FileRecord` **结构相同**）。
 *
 * 为什么不直接 import 那个类型：它定义在 `contextEngine.ts` 内且未导出（模块私有）。
 * 为它加 `export` 会把一个内部类型升成公共 API（连带 JSDoc 门禁与 `api:check` 面），
 * 收益仅是省一次结构声明——不值。结构类型在这里等价且更内聚。
 */
export interface CollectedFileRecord {
  /** 相对 POSIX 路径。 */
  readonly rel: string;
  /** 该文件正文侧的 token 计数。 */
  readonly tokens: number;
}

/** 语料件累积结果（与 `ContextEngine.collectCorpus` 的历史返回值逐字一致）。 */
export interface CollectedCorpus {
  /** 相对路径 → 全文。 */
  readonly fileText: Map<string, string>;
  /** 文件记录（路径 + token 数）。 */
  readonly fileRecords: CollectedFileRecord[];
  /** 文件级 BM25 文档集。 */
  readonly fileDocs: string[][];
  /** 全部符号（跨文件连续编号）。 */
  readonly allSymbols: SymbolNode[];
  /** 符号级 BM25 文档集。 */
  readonly symbolDocs: string[][];
}

/**
 * **语料累积器**（G8，2026-10-03）。
 *
 * ## 为什么要有它
 *
 * 语料构建原先是一个一次性循环（`ContextEngine.collectCorpus`）。要让出事件循环就得把循环切成块，
 * 而切片后**累积状态必须跨块保留**（符号编号是跨文件连续的：`artifact()` 需要"我之前的符号总数"）。
 * 若为异步路径另写一份循环，两份实现一旦漂移，同步语料与异步语料会给出**不同的检索结果且不报错**
 * ——这正是本仓 `CorpusFileParser` 当初被抽出来统一全量与增量两条路径的同一个理由。
 *
 * 故此处把"累积"这一个职责单独成类：同步与异步两条驱动都调 {@link addFile}，产物**逐位相同**。
 */
export class CorpusCollector {
  /** 相对路径 → 全文。 */
  private readonly fileText = new Map<string, string>();
  /** 文件记录。 */
  private readonly fileRecords: CollectedFileRecord[] = [];
  /** 文件级文档集。 */
  private readonly fileDocs: string[][] = [];
  /** 符号表（跨文件连续）。 */
  private readonly allSymbols: SymbolNode[] = [];
  /** 符号级文档集。 */
  private readonly symbolDocs: string[][] = [];

  /**
   * 读入并解析一个文件（读**原始字节**再解码：产物缓存要用字节哈希，而非法 UTF-8 会被 utf8
   * 解码的替换字符抹平，只有字节哈希才认得出"字节变了"）。
   *
   * 读盘/解析失败**跳过**该文件（fail-soft）：单个坏文件不该让整份语料构建失败。
   * @param root 工作区根（绝对路径）。
   * @param rel 相对 POSIX 路径。
   * @param parser 单文件解析器（与增量重建器共用）。
   * @param sink 产物接收器（可选）。
   * @returns 无返回值。
   */
  public addFile(
    root: string,
    rel: string,
    parser: CorpusFileParser,
    sink: Map<string, CorpusFileArtifact> | undefined,
  ): void {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, rel));
    } catch {
      return;
    }
    const text = bytes.toString('utf8');
    this.fileText.set(rel, text);
    const artifact = parser.artifact(
      rel,
      text,
      this.allSymbols.length,
      CorpusFileParser.hashOfBytes(bytes),
    );
    this.fileRecords.push({ rel, tokens: artifact.tokenCount });
    // 正文侧不做扩展分词（净负面 −6.0pp，见 TASK_BOARD §22.3）。
    this.fileDocs.push(artifact.fileDoc);
    for (const symbol of artifact.symbols) {
      this.allSymbols.push(symbol);
    }
    for (const doc of artifact.symbolDocs) {
      this.symbolDocs.push(doc);
    }
    sink?.set(rel, artifact);
  }

  /**
   * 取累积结果。
   * @returns 语料件（正文表 / 文件记录 / 两个 BM25 文档集 / 符号表）。
   */
  public result(): CollectedCorpus {
    return {
      fileText: this.fileText,
      fileRecords: this.fileRecords,
      fileDocs: this.fileDocs,
      allSymbols: this.allSymbols,
      symbolDocs: this.symbolDocs,
    };
  }
}
