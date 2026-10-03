import { createHash } from 'node:crypto';
import { Bm25Index } from '../search/bm25Index.js';
import { RepoMap, type SymbolNode } from './repoMap/repoMap.js';
import type { CorpusFileArtifact } from './corpusFileArtifact.js';

/** 一次文件解析的产出（词项与符号；不含路径无关的装配信息）。 */
export interface ParsedCorpusFile {
  /** 文件级 BM25 文档词项（正文 tokenize ∪ 路径扩展词）。 */
  readonly fileDoc: string[];
  /** 正文 token 数（`corpus.files[i].tokens` 口径）。 */
  readonly tokenCount: number;
  /** 抽出的符号。 */
  readonly symbols: readonly SymbolNode[];
  /** 每个符号的 BM25 文档词项。 */
  readonly symbolDocs: string[][];
}

/**
 * 语料**单文件解析器**（全量索引与增量重建共用的唯一实现）。
 *
 * 为什么必须抽成一处（2026-10-03）：增量路径若自己再写一遍分词 / 抽符号规则，
 * 两处一旦漂移，增量语料与全量语料就会给出**不同的检索结果**——而这类漂移不会报错，
 * 只会让召回静默变差。故两侧共用本类；`tests/unit/corpusIncremental.test.ts`
 * 以「增量结果 ≡ 全量结果」逐位对拍钉住。
 *
 * 口径来源（与 `ContextEngine.indexCorpus` 的历史实现逐字一致）：
 *  - 文件文档 = `tokenize(text)` ∪ `tk(rel)`（正文侧**不做**扩展分词——TASK_BOARD §22.3 实测净负面）；
 *  - `tokens` 计数**只算正文**（不含路径扩展词）；
 *  - 符号文档 = `symTk(\`${name} ${kind} ${signature} ${file}\`)`，`symTk` 为**保留词频**的扩展分词。
 */
export class CorpusFileParser {
  /**
   * 路径扩展分词器（`morph` 关时退化为朴素分词）。
   *
   * 注意**正文侧恒用朴素 `Bm25Index.tokenize`**（不做形态扩展）：这是既有实测口径
   * （正文扩展分词净负面 −6.0pp，TASK_BOARD §22.3），只有路径部分与符号文档走扩展分词。
   */
  private readonly pathTk: (text: string) => string[];
  /** 符号文档分词器（保留词频；`morph` 关时退化为朴素分词）。 */
  private readonly symbolTk: (text: string) => string[];

  /**
   * @param morph 是否启用词形归并（`morph === false` 时路径与符号退化为朴素分词）。
   */
  public constructor(morph: boolean) {
    this.pathTk = morph ? Bm25Index.tokenizeExpanded : Bm25Index.tokenize;
    this.symbolTk = morph ? Bm25Index.tokenizeExpandedCounted : Bm25Index.tokenize;
  }

  /**
   * 解析一个文件。
   * @param rel 相对 POSIX 路径。
   * @param text 文件正文。
   * @returns 词项与符号（可直接喂给 BM25 索引与语料装配）。
   */
  public parse(rel: string, text: string): ParsedCorpusFile {
    const tokens = Bm25Index.tokenize(text);
    const fileDoc = [...tokens, ...this.pathTk(rel)];
    const symbols = RepoMap.extractSymbols(rel, text);
    const symbolDocs = symbols.map((s) =>
      this.symbolTk(`${s.name} ${s.kind} ${s.signature} ${s.file}`),
    );
    return { fileDoc, tokenCount: tokens.length, symbols, symbolDocs };
  }

  /**
   * 解析并打包成可缓存的产物（附内容哈希与符号起始下标）。
   * @param rel 相对 POSIX 路径。
   * @param text 文件正文。
   * @param symbolStart 该文件首个符号在 `corpus.symbols` 中的下标。
   * @param byteHash 该文件的**原始字节** SHA-1（与 `CorpusIndexCache` 的签名复核同源；
   *   必须用字节哈希而不是「解码后文本的哈希」：非法 UTF-8 会被 `toString('utf8')` 的替换字符
   *   抹平，两份不同的坏字节可能算出同一个文本哈希，从而把「其实变了」误判成「没变」）。
   * @returns 自包含的产物记录。
   */
  public artifact(
    rel: string,
    text: string,
    symbolStart: number,
    byteHash: string,
  ): CorpusFileArtifact {
    const parsed = this.parse(rel, text);
    return {
      rel,
      hash: byteHash,
      fileDoc: parsed.fileDoc,
      tokenCount: parsed.tokenCount,
      symbols: parsed.symbols,
      symbolDocs: parsed.symbolDocs,
      symbolStart,
    };
  }

  /**
   * 原始字节的内容哈希（SHA-1，hex）。
   * @param bytes 文件原始字节。
   * @returns 内容哈希。
   */
  public static hashOfBytes(bytes: Buffer): string {
    return createHash('sha1').update(bytes).digest('hex');
  }
}
