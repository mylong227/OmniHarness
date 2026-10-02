import { join, relative } from 'node:path';
import { Bm25Index } from '../search/bm25Index.js';
import type { IndexedCorpus } from './contextEngine.js';
import type { LspLocation, LspPort } from '../ports/tool/lsp.js';

/** LSP 候选源产出的命中 id（与 {@link HybridRanker} 的输入同口径）。 */
export interface LspCandidateIds {
  /** 符号命中 id（形如 `sym:<i>`），可为空。 */
  readonly symIds: readonly string[];
  /** 文件命中 id（形如 `file:<rel>`）。 */
  readonly fileIds: readonly string[];
}

/** 单个 seed 符号的定位（用于发起 LSP 导航请求）。 */
interface SeedSymbol {
  /** seed 符号所在文件的绝对路径。 */
  readonly absFile: string;
  /** 1-based 行号。 */
  readonly line: number;
  /** 1-based 列号（符号名首字符）。 */
  readonly character: number;
  /** 该符号在 `corpus.symbols` 中的下标。 */
  readonly symIndex: number;
}

/** LSP 候选源配置旋钮。 */
export interface LspCandidateSourceOptions {
  /** BM25 取前几个命中符号作为 LSP 扩展 seed（控制延迟，默认 {@link LspCandidateSource.DEFAULT_SEED_LIMIT}）。 */
  readonly seedLimit?: number;
  /** 单个 LSP 导航请求的超时毫秒（默认 {@link LspCandidateSource.DEFAULT_TIMEOUT_MS}）。 */
  readonly perCallTimeoutMs?: number;
}

/**
 * LSP 候选源（repo-map 召回扩展路，opt-in 第四路）。
 *
 * 设计：以 BM25 命中符号为 seed，经 `lsp.references` / `lsp.definition` 扩展出这些符号
 * 「被引用 / 被定义」所在的其他文件，作为额外候选文件注入 repo-map 融合排序。直接攻击
 * 「纯词法 BM25 只能命中符号自身文件、跨文件引用不可达」的缺口（审计 §5 项 #6）。
 *
 * 性质：
 *  - **fail-closed**：任一 seed 的 LSP 调用抛错 / 超时 → 仅跳过该 seed，绝不崩主流程；
 *    全局异常 → 返回空候选（与 repo-map 引擎整体 fail-closed 一致）。
 *  - **opt-in**：仅当调用方显式传入 `LspPort` 才生效；默认 repo-map（同步 BM25）路径完全不触达本类。
 *  - **延迟有界**：每个 seed 的单次 LSP 调用受 {@link LspCandidateSourceOptions.perCallTimeoutMs} 约束，
 *    整体不会因慢服务器而无限挂起。
 *  - **无第三方依赖**：仅用 Node 内置 + 端口契约，不新增 npm 包。
 */
export class LspCandidateSource {
  /** 默认 seed 上限。 */
  public static readonly DEFAULT_SEED_LIMIT = 8;
  /** 默认单 seed 超时（毫秒）。 */
  public static readonly DEFAULT_TIMEOUT_MS = 2000;

  /**
   * 为某次查询产出 LSP 扩展候选（文件 / 符号 id）。
   * @param query 查询原文（用于 BM25 选 seed 符号）。
   * @param lsp 已配置并可达的 LSP 端口（调用方保证其生命周期）。
   * @param corpus 已索引语料（提供符号表 / 文件原文 / root）。
   * @param options 旋钮（seed 上限 / 超时）。
   * @returns 候选 id（fail-closed：异常时返回空）。
   */
  public async candidatesFor(
    query: string,
    lsp: LspPort,
    corpus: IndexedCorpus,
    options: LspCandidateSourceOptions = {},
  ): Promise<LspCandidateIds> {
    const seedLimit = options.seedLimit ?? LspCandidateSource.DEFAULT_SEED_LIMIT;
    const timeoutMs = options.perCallTimeoutMs ?? LspCandidateSource.DEFAULT_TIMEOUT_MS;
    try {
      const seeds = this.seedsFor(query, corpus, seedLimit);
      const locations = await this.expand(seeds, lsp, timeoutMs);
      return LspCandidateSource.toCandidateIds(locations, corpus);
    } catch {
      return { symIds: [], fileIds: [] };
    }
  }

  /**
   * 用 BM25 从语料取前 `seedLimit` 个匹配查询的符号作为 LSP 扩展 seed。
   * @param query 查询原文。
   * @param corpus 已索引语料。
   * @param seedLimit 最多取几个 seed。
   * @returns seed 符号定位（含绝对路径 / 1-based 行列）。
   */
  private seedsFor(query: string, corpus: IndexedCorpus, seedLimit: number): SeedSymbol[] {
    const tokens = corpus.morph ? Bm25Index.tokenizeExpanded(query) : Bm25Index.tokenize(query);
    const hits = corpus.symbolIndex.search(tokens, seedLimit);
    const out: SeedSymbol[] = [];
    for (const hit of hits) {
      const sym = corpus.symbols[hit.id];
      if (sym === undefined) continue;
      const character = this.columnOf(corpus, sym.file, sym.line, sym.name);
      if (character <= 0) continue;
      out.push({
        absFile: join(corpus.root, sym.file),
        line: sym.line,
        character,
        symIndex: hit.id,
      });
      if (out.length >= seedLimit) break;
    }
    return out;
  }

  /**
   * 取符号名在声明行中的 1-based 列号（用于 LSP 导航定位）。
   * @param corpus 语料（提供文件原文）。
   * @param rel 文件相对路径。
   * @param line 1-based 行号。
   * @param name 符号名。
   * @returns 1-based 列号；找不到返回 0（该 seed 将被跳过）。
   */
  private columnOf(corpus: IndexedCorpus, rel: string, line: number, name: string): number {
    const text = corpus.fileText.get(rel);
    if (text === undefined) return 0;
    const row = text.split('\n')[line - 1];
    if (row === undefined) return 0;
    const exact = row.indexOf(name);
    if (exact >= 0) return exact + 1;
    // 行内无精确符号名（如拆分/变形）时，退回该行首个非空白列，让 LSP 自行解析。
    const leading = /^\s*/.exec(row);
    const start = leading === null ? 0 : leading[0].length;
    return start + 1;
  }

  /**
   * 对每个 seed 并发调用 references + definition，收集全部命中位置（fail-closed / 超时跳单个）。
   * @param seeds seed 符号。
   * @param lsp LSP 端口。
   * @param timeoutMs 单 seed 单调用超时。
   * @returns 全部 LSP 位置（未去重）。
   */
  private async expand(
    seeds: readonly SeedSymbol[],
    lsp: LspPort,
    timeoutMs: number,
  ): Promise<LspLocation[]> {
    const collected: LspLocation[] = [];
    const tasks: Promise<void>[] = [];
    for (const seed of seeds) {
      tasks.push(
        this.safeNav(() => lsp.references(seed.absFile, seed.line, seed.character), timeoutMs).then(
          (locs) => {
            for (const loc of locs) collected.push(loc);
          },
        ),
        this.safeNav(() => lsp.definition(seed.absFile, seed.line, seed.character), timeoutMs).then(
          (locs) => {
            for (const loc of locs) collected.push(loc);
          },
        ),
      );
    }
    await Promise.all(tasks);
    return collected;
  }

  /**
   * 带超时与异常吞没的 LSP 导航调用（fail-closed：抛错 / 超时返回空数组）。
   * @param call 发起一次 LSP 导航（references / definition）。
   * @param timeoutMs 超时毫秒。
   * @returns 位置列表；异常或超时返回空。
   */
  private async safeNav(
    call: () => Promise<readonly LspLocation[]>,
    timeoutMs: number,
  ): Promise<readonly LspLocation[]> {
    try {
      return await LspCandidateSource.withTimeout(call(), timeoutMs);
    } catch {
      return [];
    }
  }

  /**
   * 把 LSP 位置列表转成 repo-map 候选 id（file:<rel> 去重；命中已知符号则补 sym:<i>）。
   * @param locations LSP 返回的位置（绝对路径 uri）。
   * @param corpus 语料（取 root 做相对化 + 符号行映射）。
   * @returns 候选 id。
   */
  private static toCandidateIds(
    locations: readonly LspLocation[],
    corpus: IndexedCorpus,
  ): LspCandidateIds {
    const fileIds = new Set<string>();
    const symIds = new Set<string>();
    const lineToSym = new Map<string, number>();
    for (let i = 0; i < corpus.symbols.length; i += 1) {
      const s = corpus.symbols[i];
      if (s === undefined) continue;
      lineToSym.set(`${s.file}:${String(s.line)}`, i);
    }
    for (const loc of locations) {
      const rel = LspCandidateSource.toRel(loc.uri, corpus.root);
      if (rel === '') continue;
      fileIds.add(`file:${rel}`);
      const key = `${rel}:${String(loc.range.start.line + 1)}`;
      const symIdx = lineToSym.get(key);
      if (symIdx !== undefined) symIds.add(`sym:${String(symIdx)}`);
    }
    return { symIds: [...symIds], fileIds: [...fileIds] };
  }

  /**
   * 把 LSP 绝对路径 uri 转回相对仓库根的路径（正斜杠）。
   * @param uri 绝对文件系统路径（LspLocation.uri 已是普通路径，非 file://）。
   * @param root 仓库根绝对路径。
   * @returns 相对路径；不在 root 内返回空串。
   */
  private static toRel(uri: string, root: string): string {
    const rel = relative(root, uri).split('\\').join('/');
    return rel === '' || rel.startsWith('..') ? '' : rel;
  }

  /**
   * Promise 超时封装：超时或异常时 reject（由调用方吞没为空），底层 promise 静默消化避免未处理拒绝。
   * @param promise 目标 promise。
   * @param ms 超时毫秒。
   * @returns 原值；超时 reject。
   */
  private static withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    void promise.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lsp timeout')), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}
