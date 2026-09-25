/**
 * 零依赖上下文引擎（repo-map + BM25 检索式上下文）。
 *
 * 与「整文件硬塞」或「裸 grep 整文件」相比：用结构大纲 + 相关符号签名
 * 构成紧凑上下文，在同等相关文件召回下把 token 成本压低一个数量级。
 *
 * 这是「上下文效率碾压」这一可证伪命题的真实落地模块，不依赖任何外部服务。
 */

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Bm25Index } from '../search/bm25Index.js';
import { RepoMap, type SymbolNode } from './repoMap.js';
import { EigenSpectrum, RESONANCE_BINS, type Spectrum } from '../util/eigenspectrum.js';
import { CodeGraphIndex, type CodeGraph } from './codeGraphIndex.js';
import { LayeredCodeGraph } from './layeredCodeGraph.js';
import { LsaEngine, type LsaModel } from './lsaEngine.js';
import { ArrayAt } from '../util/arrayAt.js';
import { ContentStopWords } from './contentStopWords.js';
import { FileReranker } from './fileReranker.js';
import { WorkspaceFileWalker } from '../util/workspaceFileWalker.js';
import { log } from '../util/logger.js';

/** 语料遍历的上限（三个上限共同把索引内存钉死，见 {@link ContextEngine.walk}）。 */
export interface WalkLimits {
  /** 最多纳入多少文件（缺省 {@link ContextEngine.MAX_FILES}）。 */
  readonly maxFiles?: number | undefined;
  /** 单文件字节上限，超过即**不入符号地图**（缺省 {@link ContextEngine.MAX_FILE_BYTES}）。 */
  readonly maxFileBytes?: number | undefined;
  /** 语料总字节预算，超过即截断（缺省 {@link ContextEngine.MAX_TOTAL_BYTES}）。 */
  readonly maxTotalBytes?: number | undefined;
}

/** 遍历结果（如实回报「地图少了一块」的两类原因）。 */
export interface WalkOutcome {
  /** 是否因文件数 / 总字节上限被截断。 */
  readonly truncated: boolean;
  /** 因单文件超过字节上限而未纳入的文件数。 */
  readonly skippedLargeFiles: number;
  /** 纳入文件的字节总数（上限判决与「语料多大」都以此为准）。 */
  readonly totalBytes: number;
}

/** 遍历期状态（递归用；`out` 为累积结果）。 */
interface WalkState {
  /** 结果累积（相对 POSIX 路径）。 */
  readonly out: string[];
  /** 还能纳入多少文件。 */
  remaining: number;
  /** 还能纳入多少字节。 */
  bytesLeft: number;
  /** 单文件字节上限。 */
  maxFileBytes: number;
  /** 是否因文件数 / 总字节上限而截断。 */
  truncated: boolean;
  /** 因单文件过大而被排除的文件数（如实回报，不静默）。 */
  skippedLarge: number;
  /** 已纳入文件的字节总数。 */
  bytesTaken: number;
}

/**
 * ContextEngine 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class ContextEngine {
  /** 单次索引最多纳入的文件数（与 {@link WorkspaceFileWalker} 同口径，避免两套遍历器各说各话）。 */
  public static readonly MAX_FILES = WorkspaceFileWalker.DEFAULT_MAX_FILES;

  /**
   * 单文件字节上限（512 KiB）：超过它的源码文件基本是生成物 / 打包产物 / 数据转储，
   * 对「符号地图」零价值，却会一次性吃掉几十上百 MB 堆——故策略性排除并计数上报。
   */
  public static readonly MAX_FILE_BYTES = 512 * 1024;

  /**
   * 语料总字节预算（32 MiB）。为什么必须有它：`indexCorpus` 会把每个文件的**全文**
   * 与分词结果留在内存里（`fileText` + BM25 文档），实测内存约为原始文本的 10~20 倍；
   * 只限文件数（2 万个 × 512 KiB）最坏仍可达 10 GB ⇒ 必须同时有总量闸。
   */
  public static readonly MAX_TOTAL_BYTES = 32 * 1024 * 1024;

  /**
   * full 模式（`light !== true`）的**告警**阈值（2 MiB）。
   *
   * 为什么单列：full 模式要额外建频域谱、代码图与 LSA，**每字节内存代价比 light 高一个数量级**——
   * 2026-09-19 实测本仓 `src/`（533 文件 / 4 MB 语料 / 9,080 符号）在 full 模式下
   * **峰值 RSS 1,522 MB、耗时 83 秒**（light 模式同语料毫秒级、RSS 百 MB 内）。
   * 生产路径（`CorpusIndexCache`）恒传 `light: true`，故这一档只服务评测脚本；
   * 一旦有人把大语料喂进 full 模式，必须**立刻在日志里看得见**，而不是等它把机器拖进 swap。
   * 这里只告警不改变行为——该档的口径由评测脚本决定，擅改会污染既有对照。
   */
  public static readonly FULL_MODE_WARN_BYTES = 2 * 1024 * 1024;

  /**
   * full 模式的**硬预算**（5 MiB）：超过即拒绝索引（fail-closed，绝不静默部分索引）。
   *
   * 定档依据（2026-09-19 实测，非拍脑袋）：full 模式的峰值内存约为语料的 **0.37 GB/MiB**
   * （本仓 `src/` 3.01 MiB ⇒ 峰值 RSS 1,522 MB、83 秒），故 5 MiB 把峰值钉在 ~1.9 GB 以内；
   * 同时留出 66% 余量，让现网评测脚本（`rank-veto-retro.mjs` / `context-efficiency/bench.mjs`
   * 等确实要用 `corpus.codeGraph` 的脚本，语料即本仓 `src/`）继续可跑。
   * 需要更大 full 语料者必须**显式**传 `maxTotalBytes`（等于承认那份内存代价）。
   */
  public static readonly MAX_TOTAL_BYTES_FULL = 5 * 1024 * 1024;

  /**
   * 收集参与索引的源码文件（同步；供 `indexCorpus` 使用）。
   *
   * ## 为什么重写（2026-09-19，堆爆修复）
   *
   * 原实现自带一套「只跳过 node_modules / dist / 点目录」的遍历，**与 `WorkspaceFileWalker`
   * 的忽略清单不一致**，于是 `eval-data/`（2.3 GB、10.4 万个随仓克隆的 `.py`）与
   * `target/`（2.2 GB Rust 构建产物）会被当成语料全量读进内存 ⇒ `npm run smoke` 跑 7 分钟后
   * 4 GB 堆爆（同一工作区实测 15.2 万文件 / 4.6 GB）。现在忽略策略只有**一份**
   * （{@link WorkspaceFileWalker.DEFAULT_IGNORED_DIRS}），并且文件数 / 单文件 / 总字节三道闸
   * 一起把内存钉死：任何工作区都只会索引「有界的源码子集」，绝不把整机拖进 swap。
   *
   * 另外跳过符号链接（`lstatSync`）：链接成环会让遍历永不终止，这是同一类「无界增长」。
   *
   * @param root 遍历起点（绝对路径）。
   * @param absRoot 计算相对路径的基准（通常等于 root）。
   * @param out 结果累积数组（就地追加相对 POSIX 路径）。
   * @param limits 上限覆盖（缺省取本类常量）。
   * @returns 截断标记与「因过大被排除的文件数」（调用方须如实转达，不得静默丢弃）。
   */
  public static walk(
    root: string,
    absRoot: string,
    out: string[],
    limits: WalkLimits = {},
  ): WalkOutcome {
    // 根不可读 / 不是目录 ⇒ **抛错**（而不是回空语料）：调用方（`CorpusIndexCache`）据此
    // fail-closed 返回 null，`getRepoMapContext` 随之为 null。若在这里吞成「空语料」，
    // 坏路径会被伪装成「索引成功但没东西」——正是本仓反复治理的「静默失败」形态。
    let rootStat: ReturnType<typeof statSync>;
    try {
      rootStat = statSync(root);
    } catch (error) {
      throw new Error(
        `语料根不可读：${root}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`语料根不是目录：${root}`);
    }
    const state: WalkState = {
      out,
      remaining: limits.maxFiles ?? ContextEngine.MAX_FILES,
      bytesLeft: limits.maxTotalBytes ?? ContextEngine.MAX_TOTAL_BYTES,
      maxFileBytes: limits.maxFileBytes ?? ContextEngine.MAX_FILE_BYTES,
      truncated: false,
      skippedLarge: 0,
      bytesTaken: 0,
    };
    ContextEngine.walkInto(state, root, absRoot);
    return {
      truncated: state.truncated,
      skippedLargeFiles: state.skippedLarge,
      totalBytes: state.bytesTaken,
    };
  }

  /**
   * 递归遍历实现（忽略清单 + 三道上限 + 跳过符号链接）。
   *
   * @param state 遍历状态（就地更新）。
   * @param dir 当前目录。
   * @param absRoot 相对路径基准。
   * @returns 无返回值。
   */
  private static walkInto(state: WalkState, dir: string, absRoot: string): void {
    if (state.truncated) {
      return;
    }
    let entries: readonly string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (state.truncated) {
        return;
      }
      const abs = join(dir, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        continue;
      }
      if (st.isDirectory()) {
        if (entry.startsWith('.') || WorkspaceFileWalker.DEFAULT_IGNORED_DIRS.has(entry)) {
          continue;
        }
        ContextEngine.walkInto(state, abs, absRoot);
        continue;
      }
      if (!st.isFile() || !ContextEngine.isIndexable(entry)) {
        continue;
      }
      if (st.size > state.maxFileBytes) {
        state.skippedLarge += 1;
        continue;
      }
      if (state.remaining <= 0 || st.size > state.bytesLeft) {
        state.truncated = true;
        return;
      }
      state.out.push(relative(absRoot, abs).split(sep).join('/'));
      state.remaining -= 1;
      state.bytesLeft -= st.size;
      state.bytesTaken += st.size;
    }
  }

  /**
   * 该文件名是否是本引擎索引的源码类型。
   *
   * @param name 文件名。
   * @returns `.ts` / `.js` / `.py` 之一时为 true。
   */
  private static isIndexable(name: string): boolean {
    return name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.py');
  }

  /**
   * 层化图构建缓存：按语料实例 WeakMap 缓存，避免每次查询重扫全仓建边。
   * E4 深化：层化图作为第三路软融合并入 `query` 的 fileScore（见 `query` 内 useLayered 分支）。
   */
  private static readonly layeredGraphCache = new WeakMap<IndexedCorpus, CodeGraph>();

  /**
   * 取（或构建并缓存）某语料的层化代码图。
   * @param corpus 已索引语料（含 symbols 与 fileText，满足 GraphSource 视图）
   * @returns 层化有向带权邻接表
   */
  public static getLayeredGraph(corpus: IndexedCorpus): CodeGraph {
    const cached = ContextEngine.layeredGraphCache.get(corpus);
    if (cached !== undefined) return cached;
    const g = LayeredCodeGraph.buildLayeredCodeGraph({
      symbols: corpus.symbols,
      fileText: corpus.fileText,
    });
    ContextEngine.layeredGraphCache.set(corpus, g);
    return g;
  }

  /**
   * 索引某个目录下的源码，构建符号级与文件级双 BM25 索引。
   *
   * **内存有界（2026-09-19 堆爆修复）**：遍历只走 `WorkspaceFileWalker` 的忽略清单
   * （`.git` / `node_modules` / `dist` / `target` / `eval-data` / venv / 缓存 …），
   * 且受文件数、单文件字节、语料总字节三道闸约束；被截断或被排除的事实经
   * {@link IndexedCorpus.truncated} / {@link IndexedCorpus.skippedLargeFiles} 如实回报。
   */
  public static indexCorpus(root: string, opts: IndexOptions = {}): IndexedCorpus {
    // 索引侧与查询侧必须同用一套分词，否则两侧变体集不相交，归并反而掉召回。
    const tk = opts.morph === false ? Bm25Index.tokenize : Bm25Index.tokenizeExpanded;
    // light 模式：跳过三项重型索引（**默认开**；要 full 必须显式 `light: false`）。
    const light = opts.light !== false;
    const files: string[] = [];
    const budget =
      opts.maxTotalBytes ??
      (light ? ContextEngine.MAX_TOTAL_BYTES : ContextEngine.MAX_TOTAL_BYTES_FULL);
    const walked = ContextEngine.walk(root, root, files, {
      ...(opts.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {}),
      ...(opts.maxFileBytes !== undefined ? { maxFileBytes: opts.maxFileBytes } : {}),
      maxTotalBytes: budget,
    });
    const truncated = walked.truncated;
    const skippedLargeFiles = walked.skippedLargeFiles;
    if (!light) {
      // full 模式的每字节代价比 light 高一个数量级（见 FULL_MODE_WARN_BYTES 的实测），
      // 大语料必须**拒跑**而不是「静默只索引一半」——半份语料会给出错误的对照结论。
      const explicitBudget = opts.maxTotalBytes !== undefined;
      if (truncated && !explicitBudget) {
        throw new Error(
          `full 模式语料超出上限（文件数或总字节）：已纳入 ${String(walked.totalBytes)} 字节 / ${String(files.length)} 文件，上限 ${String(Math.round(budget / 1048576))} MiB（根：${root}）。` +
            'full 模式峰值内存约为语料的 0.37 GB/MiB（实测），请改用 light: true（生产默认），' +
            '或显式传 maxTotalBytes 以确认接受该内存代价。',
        );
      }
      if (walked.totalBytes > (opts.fullModeWarnBytes ?? ContextEngine.FULL_MODE_WARN_BYTES)) {
        log.warn(
          'indexCorpus 以 full 模式索引较大语料（频谱 / 代码图 / LSA），峰值内存可达 GB 级',
          {
            root,
            corpusMiB: Number((walked.totalBytes / 1048576).toFixed(2)),
            budgetMiB: Number((budget / 1048576).toFixed(2)),
            advice:
              '生产路径请传 light: true（CorpusIndexCache 已如此）；full 仅用于小语料的对照评测',
          },
        );
      }
    }
    const fileText = new Map<string, string>();
    const allSymbols: SymbolNode[] = [];
    const fileRecords: FileRecord[] = [];
    const symbolDocs: string[][] = [];
    const fileDocs: string[][] = [];

    for (const rel of files) {
      let text: string;
      try {
        text = readFileSync(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      fileText.set(rel, text);
      const toks = Bm25Index.tokenize(text);
      fileRecords.push({ rel, tokens: toks.length });
      fileDocs.push([...toks, ...tk(rel)]);

      const syms = RepoMap.extractSymbols(rel, text);
      for (const s of syms) {
        allSymbols.push(s);
        symbolDocs.push(tk(`${s.name} ${s.kind} ${s.signature} ${s.file}`));
      }
    }

    // exactOptionalPropertyTypes：仅装配显式提供的参数，缺省交由 Bm25Index 自身默认（1.5 / 0.75）。
    const bm25Init = {
      ...(opts.bm25K1 !== undefined ? { k1: opts.bm25K1 } : {}),
      ...(opts.bm25B !== undefined ? { b: opts.bm25B } : {}),
    };
    const symbolIndex = new Bm25Index(bm25Init);
    symbolIndex.addDocuments(symbolDocs);
    const fileIndex = new Bm25Index(bm25Init);
    fileIndex.addDocuments(fileDocs);

    // 燧-3 频域索引：每个符号的名/类/签名映射到本征频谱，用于共振召回（与 BM25 时域/词袋互补）。
    // light 模式跳过（2026-09-05 诚实重测：同 corpus「频谱开/关」隔离对照，文件召回 41.4% = 41.4%
    // —— 纯零效应；此前某次「+2.5pp」是 full vs light 两语料混淆对比的假象）。频域共振/图/LSA 三项
    // 在 omniharness 语料上实测均零增益或净负面（详见 evals/validation-2026-09-05.md 第 9 节）。
    const symbolSpectra: Spectrum[] = light
      ? []
      : allSymbols.map((s) =>
          EigenSpectrum.eigenSpectrum(`${s.name} ${s.kind} ${s.signature}`, RESONANCE_BINS),
        );

    // 代码拓扑图在语料齐全后再建（依赖 fileText 与 symbols 的完整映射）。light 模式跳过
    // （429k 稠密边 PageRank 实测零增益且额外增 token，净负面）。
    const codeGraph = light
      ? EMPTY_GRAPH
      : CodeGraphIndex.buildCodeGraph({ symbols: allSymbols, fileText });
    // 潜语义模型：在符号级 TF-IDF 上做截断 SVD（零依赖随机 SVD + Jacobi），训练一次随语料复用。
    // light 模式跳过：LSA 在 morph 之上实测符号精确率腰斩，净负面。
    const lsaModel = light ? EMPTY_LSA : LsaEngine.trainLsa({ symbols: allSymbols, fileText });

    return {
      root,
      morph: opts.morph !== false,
      symbols: allSymbols,
      files: fileRecords,
      symbolIndex,
      fileIndex,
      symbolSpectra,
      fileText,
      codeGraph,
      lsaModel,
      truncated,
      skippedLargeFiles,
    };
  }

  /**
   * 检索式上下文（混合打分版）：
   * 每个文件的得分 = max(文件BM25分, 0.7 × 该文件内最强符号BM25分)。
   * 这样既保留文件级语义，又能把「文件级弱命中但含强相关符号」的文件（如 registerTool）
   * 捞回 Top-K，并在固定文件数上限内给出紧凑上下文——召回与压缩兼得。
   *
   * `opts.rerank: true` 时在上述第一段之后追加**第二段零依赖词法精排**
   * （见 {@link FileReranker}）：按「符号名 IDF 加权覆盖率」重排候选池，取 Top-K。
   * 该阶段只重排已入池文件，不新增候选，故不引入常量偏置。
   *
   * **历史死参数已移除（2026-09-16）**：签名原为 `query(corpus, q, k = 20, opts)`，
   * 但函数体**从不读取 `k`**——第一段候选数由下方固定候选上限（符号 60 / 文件 20）承担，
   * 文件预算由 `opts.fileK` 决定。调用方（生产 `RepoMapContextEngine` 传
   * `BM25_ONLY_CANDIDATES`=20、单测传 14/20）的取值一直被静默丢弃。因该参数无任何
   * 实际效果，直接移除**不改变行为**；把「候选数」重新做成可配置旋钮需单独评测，不在此处顺手改。
   */

  public static query(
    corpus: IndexedCorpus,
    q: string,
    opts: {
      prf?: boolean;
      graph?: boolean;
      lsa?: boolean;
      layered?: boolean;
      fileK?: number;
      symK?: number;
      /** BM25 `k1` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
      bm25K1?: number;
      /** BM25 `b` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
      bm25B?: number;
      /**
       * 第二段重排（零依赖词法精排，见 `FileReranker`）。默认 **false**：
       * `query()` 的既有调用方（基准脚本 / 单测，冻结过报告口径）零行为变更；
       * 生产入口 `RepoMapContextEngine.getRepoMapContext` 显式传 true。
       */
      rerank?: boolean;
      /**
       * 重排的头部地板个数（把第一段前 N 个候选钉在原位）。缺省交由 `FileReranker`
       * 按 `round(fileK / 3)` 决定（实测两档 fileK 下的最优点）。仅在 `rerank: true` 时生效。
       */
      rerankFloor?: number;
    } = {},
  ): QueryResult {
    // 图检索默认关闭：实测在本语料上净负面。
    // 根因（evals/rank-veto-retro.mjs 实测，已更正早期「收敛至近均匀」的错误解释）：
    // 图排序对查询不敏感——Top-14 跨查询重合度 0.936，而 BM25 仅 0.058，
    // 等于给每条查询塞同一批枢纽文件，构成常量偏置，挤掉真正相关的文件。
    // 保留模块与 graph:true 开关供稀疏高质量边/语义权重场景使用。
    const useGraph = opts.graph === true;
    // E4 深化：层化图软融合（第三路，非替换）。默认关，仅供评测开启；D6 第二关未达标前不破生产口径。
    const useLayered = opts.layered === true;
    // LSA 默认关闭：实测在「词形归并」之上叠加 LSA，召回无增益（67.0% 持平），
    // 但符号精确率从 25.5% 腰斩至 10.5%（潜语义扩展引入噪声，挤掉真相关符号）。
    // 模块保留（lsa:true 可开启），供后续改用更高秩/稀疏化后重新评估。
    const useLsa = opts.lsa === true;
    // 第二段重排（打磨第二批 P1）：默认 **false** —— 直接调用 `query()` 的调用方（基准 / 单测）
    // 行为逐字不变；生产入口 `RepoMapContextEngine.getRepoMapContext` 会显式传 true。
    // 这样既让生产拿到收益，又不会悄悄改写任何已冻结的评测报告口径。
    const useRerank = opts.rerank === true;
    const qk = corpus.morph ? Bm25Index.tokenizeExpanded(q) : Bm25Index.tokenize(q);
    const FILE_K = opts.fileK ?? 14;
    const SYM_K = opts.symK ?? 30;
    // 打分期 BM25 参数覆盖（调参扫描）：索引与 k1/b 无关，故同一语料可零成本重打分。
    const bm25Args = {
      ...(opts.bm25K1 !== undefined ? { k1: opts.bm25K1 } : {}),
      ...(opts.bm25B !== undefined ? { b: opts.bm25B } : {}),
    };
    let bm25SymHits = [...corpus.symbolIndex.search(qk, 60, bm25Args)];
    let fileHits = [...corpus.fileIndex.search(qk, 20, bm25Args)];

    // 伪相关反馈（PRF / RM3 风格查询扩展）：突破纯词法召回天花板。零依赖、可测。
    // 实现要点（经 evals/recall-precision.mjs 实测校准，复刻该脚本的获胜配方）：
    //  - 取首轮 Top-R 文件（R=20，与基准脚本一致）作为反馈集；
    //  - 反馈集内 TF·IDF 加权选 Top-E 扩展词（E=6——太多引入噪声稀释头部）；
    //  - **重排（替换）而非并集**：扩展查询直接重跑 BM25、取新 Top-K 重排序，
    //    避免噪声候选挤掉真相关文件（朴素并集会把泛化词命中的文件顶进头部，实测 hitRate 39%→9% 崩塌）。
    //  IDF 用语料级 docFreq（按 corpus 缓存，避免每次查询重建）。
    if (opts.prf) {
      const df = ContextEngine.docFreqOf(corpus);
      const N = corpus.files.length;
      const topFiles = fileHits
        .slice(0, 20)
        .map((h) => corpus.files[h.id]?.rel)
        .filter((r): r is string => r !== undefined);
      const fb = new Map<string, number>();
      for (const rel of topFiles) {
        const text = corpus.fileText.get(rel);
        if (text === undefined) continue;
        const tf = new Map<string, number>();
        for (const t of Bm25Index.tokenizeExpanded(text)) {
          if (!ContentStopWords.isContent(t)) continue;
          tf.set(t, (tf.get(t) ?? 0) + 1);
        }
        const len = Math.max(
          1,
          [...tf.values()].reduce((a, b) => a + b, 0),
        );
        for (const [t, c] of tf) {
          const d = df.get(t) ?? 0;
          const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
          fb.set(t, (fb.get(t) ?? 0) + (c / len) * idf);
        }
      }
      const qTok = new Set(Bm25Index.tokenizeExpanded(q));
      const extra = [...fb.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map((e) => e[0])
        .filter((t) => !qTok.has(t));
      if (extra.length > 0) {
        const eqk = Bm25Index.tokenizeExpanded(`${q} ${extra.join(' ')}`);
        // 重排：扩展查询重跑 BM25，直接替换候选（重排序由 BM25 分数决定），不并集。
        bm25SymHits = [...corpus.symbolIndex.search(eqk, 60, bm25Args)];
        fileHits = [...corpus.fileIndex.search(eqk, 20, bm25Args)];
      }
    }

    // 燧-3 频域召回：把查询映射成频谱探针，与每个符号本征谱共振，取 Top-K 符号。
    // 与 BM25（词袋/时域）代数互补——频率偏移、字符分布差异可被频域捕获。
    const probe = EigenSpectrum.eigenSpectrum(q, RESONANCE_BINS);
    const resHits: Array<{ id: number; score: number }> = [];
    for (let i = 0; i < corpus.symbolSpectra.length; i++) {
      const sp = corpus.symbolSpectra[i];
      if (sp === undefined) continue;
      const sc = EigenSpectrum.resonance(sp, probe);
      if (sc > 1e-4) resHits.push({ id: i, score: sc });
    }
    resHits.sort((a, b) => b.score - a.score);
    const resSymIds = new Set(resHits.slice(0, SYM_K * 2).map((h) => h.id));

    // 潜语义（LSA）召回：把查询投影到潜空间，召回「概念相关」符号（桥接词法错位）。
    let lsaHits: Array<{ id: number; score: number }> = [];
    let lsaMax = 0;
    if (useLsa && corpus.lsaModel) {
      lsaHits = LsaEngine.lsaQuery(corpus.lsaModel, q, 60);
      for (const h of lsaHits) lsaMax = Math.max(lsaMax, Math.abs(h.score));
    }

    // BM25 符号 ∪ 共振符号 ∪ LSA 符号（并集 → 作为图扩散的种子）。
    const symIdSet = new Set<number>();
    for (const h of bm25SymHits) symIdSet.add(h.id);
    for (const id of resSymIds) symIdSet.add(id);
    for (const h of lsaHits) symIdSet.add(h.id);

    // 种子分数：BM25 / 共振 / LSA 各自归一化后加权，作为 PageRank 重启向量。
    let bm25Max = 0;
    for (const h of bm25SymHits) bm25Max = Math.max(bm25Max, h.score);
    let resMax = 0;
    for (const h of resHits) resMax = Math.max(resMax, h.score);
    const seed = new Map<number, number>();
    for (const h of bm25SymHits) {
      if (bm25Max > 0) seed.set(h.id, (h.score / bm25Max) * 0.6);
    }
    for (const h of resHits) {
      const norm = resMax > 0 ? h.score / resMax : 0;
      const cur = seed.get(h.id) ?? 0;
      seed.set(h.id, Math.max(cur, norm * 0.4));
    }
    for (const h of lsaHits) {
      const norm = lsaMax > 0 ? Math.abs(h.score) / lsaMax : 0;
      const cur = seed.get(h.id) ?? 0;
      seed.set(h.id, Math.max(cur, norm * 0.5));
    }

    // 图扩散：把种子分数沿代码拓扑图传播，关联符号被抬升（突破纯词法天花板）。
    let finalScores: Float64Array;
    if (useGraph) {
      finalScores = CodeGraphIndex.propagate(corpus.codeGraph, seed, 4, 0.85);
      let fmax = 0;
      for (let i = 0; i < finalScores.length; i++)
        fmax = Math.max(fmax, ArrayAt.at(finalScores, i));
      const THRESH = 0.12 * (fmax || 1);
      for (let i = 0; i < finalScores.length; i++) {
        if ((finalScores[i] ?? 0) >= THRESH) symIdSet.add(i);
      }
    } else {
      // 关图：直接以种子分数聚合，作为可对照的 baseline（= 上一轮 58.5% 配置）。
      finalScores = new Float64Array(corpus.symbols.length);
      for (const [id, v] of seed) {
        if (id >= 0 && id < finalScores.length) finalScores[id] = v;
      }
    }

    // 每个文件内最强符号分（用扩散后分值，关联符号被抬升 → 关联文件被捞回）。
    const bestSymbolScore = new Map<string, number>();
    for (const id of symIdSet) {
      const s = corpus.symbols[id];
      if (s === undefined) continue;
      const sc = finalScores[id] ?? 0;
      const cur = bestSymbolScore.get(s.file) ?? 0;
      if (sc > cur) bestSymbolScore.set(s.file, sc);
    }

    // E4 深化：层化图作为第三路软融合（非替换），保留文件 BM25 地板。
    // 根因（evals/layered-recall-ab.mjs 实测）：层化图此前作「替换」BM25 用，丢掉整文件
    // 词法命中信号 → −9.1pp。改为把图扩散分并入 fileScore 的 max，图只负责「捞回靠关联符号
    // 但无词法命中」的文件，文件 BM25 始终为地板项（绝不被静默丢弃）。
    const layeredFileScore = new Map<string, number>();
    if (useLayered) {
      const lg = ContextEngine.getLayeredGraph(corpus);
      const lscores = CodeGraphIndex.propagate(lg, seed, 4, 0.85);
      let lmax = 0;
      for (let i = 0; i < lscores.length; i += 1) lmax = Math.max(lmax, lscores[i] ?? 0);
      const linv = lmax > 0 ? 1 / lmax : 0;
      for (let i = 0; i < lscores.length; i += 1) {
        const v = (lscores[i] ?? 0) * linv;
        if (v <= 0) continue;
        const s = corpus.symbols[i];
        if (s === undefined) continue;
        symIdSet.add(i);
        const cur = layeredFileScore.get(s.file) ?? 0;
        if (v > cur) layeredFileScore.set(s.file, v);
      }
    }

    // 文件混合分：max(文件BM25, 0.7×符号BM25分, 0.5×层化图分)。
    const fileScore = new Map<string, number>();
    for (const h of fileHits) {
      const f = corpus.files[h.id];
      if (f === undefined) continue;
      const sym = bestSymbolScore.get(f.rel) ?? 0;
      const lay = layeredFileScore.get(f.rel) ?? 0;
      fileScore.set(f.rel, Math.max(h.score, 0.7 * sym, 0.5 * lay));
    }
    for (const [file, sym] of bestSymbolScore) {
      if (!fileScore.has(file)) fileScore.set(file, 0.7 * sym);
    }
    for (const [file, lay] of layeredFileScore) {
      if (!fileScore.has(file)) fileScore.set(file, 0.5 * lay);
    }
    // 第一段候选（**完整** fileScore，不按 FILE_K 截断）：候选池已由「BM25 文件路 ∪ 符号路映射回的文件」
    // 构成——实测该池在真实语料上已饱和（继续放大池子上界，召回 0 增益），故**不另起候选源**
    // （新候选源若与查询不敏感即构成常量偏置，见 `rankVetoEvaluator`）。
    const candidateFiles = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
    // 第二段：重排（默认关；见上方 useRerank）。重排只重排入池文件，不新增/删除候选。
    const rankedFiles = useRerank
      ? [
          ...fileReranker.rerank({
            corpus,
            query: q,
            candidates: candidateFiles,
            fileK: FILE_K,
            ...(opts.rerankFloor !== undefined ? { floor: opts.rerankFloor } : {}),
          }).files,
        ]
      : candidateFiles.slice(0, FILE_K);

    const symbols = [...symIdSet]
      .map((id) => ({ s: corpus.symbols[id], v: finalScores[id] ?? 0 }))
      .filter((x): x is { s: SymbolNode; v: number } => x.s !== undefined)
      .sort((a, b) => b.v - a.v)
      .slice(0, SYM_K)
      .map((x) => x.s);
    const fileSet = new Set(rankedFiles);

    const outline = RepoMap.outlineText(corpus.symbols.filter((s) => fileSet.has(s.file)));
    const sigLines = symbols.map((s) => `L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
    const context = [
      '# Repo Map (relevant files)',
      outline,
      '# Relevant Symbols',
      ...sigLines,
    ].join('\n');

    return { context, tokens: Bm25Index.tokenize(context).length, symbols, files: rankedFiles };
  }

  public static docFreqOf(corpus: IndexedCorpus): Map<string, number> {
    const cached = DF_CACHE.get(corpus);
    if (cached !== undefined) return cached;
    const df = new Map<string, number>();
    for (const text of corpus.fileText.values()) {
      const seen = new Set(Bm25Index.tokenizeExpanded(text));
      for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    }
    DF_CACHE.set(corpus, df);
    return df;
  }

  /** 整语料 token 总量（整文件硬塞 baseline 的上界）。 */
  public static wholeCorpusTokens(corpus: IndexedCorpus): number {
    let total = 0;
    for (const f of corpus.files) {
      total += f.tokens;
    }
    return total;
  }

  /**
   * 竞品 baseline（B）：关键词检索 → 取 Top-K 整文件。
   * 返回命中的文件相对路径，供基准同时测算「竞品召回率」——
   * 只比较我方召回、不比较竞品召回的成果对比是不公平的。
   */
  public static grepTopKFiles(corpus: IndexedCorpus, q: string, k = 8): string[] {
    const qk = corpus.morph ? Bm25Index.tokenizeExpanded(q) : Bm25Index.tokenize(q);
    const hits = corpus.fileIndex.search(qk, k);
    const out: string[] = [];
    for (const h of hits) {
      const file = corpus.files[h.id];
      if (file !== undefined && corpus.fileText.has(file.rel)) out.push(file.rel);
    }
    return out;
  }

  /**
   * 取与查询最相关的 Top-K 文件，累加其 token 总量（用于预算/容量评估）。
   * @param corpus 已索引语料（含文件 token 计数）
   * @param q 查询字符串
   * @param k 取前 k 个文件（缺省 8）
   * @returns Top-K 文件的 token 总和
   */
  public static grepTopKWholeFileTokens(corpus: IndexedCorpus, q: string, k = 8): number {
    const rels = ContextEngine.grepTopKFiles(corpus, q, k);
    let total = 0;
    for (const rel of rels) {
      const rec = corpus.files.find((f) => f.rel === rel);
      if (rec !== undefined) total += rec.tokens;
    }
    return total;
  }
}

/**
 * 空 LSA 模型（light 模式占位）：k=n=0、所有数组空。
 * `query` 仅在 `lsa:true` 时调用 `lsaQuery`；即便有人误开，n=0 让所有循环空转不崩。
 */
const EMPTY_LSA: LsaModel = {
  k: 0,
  n: 0,
  termIndex: new Map<string, number>(),
  symLatent: new Float64Array(0),
  U: new Float64Array(0),
  sigma: new Float64Array(0),
};

/** 空代码拓扑图（light 模式占位）：零节点零边。 */
const EMPTY_GRAPH: CodeGraph = { n: 0, adj: [] };

/** 代码停用词（PRF 扩展与重排的内容词筛选共用；表本身见 `ContentStopWords`）。 */

/**
 * 第二段重排器（打磨第二批 P1）。模块内单例：其内部只持「按语料 WeakMap 缓存」的词法视图，
 * **不导出**，故不构成跨模块可变的全局状态；同一进程内多语料互不干扰。
 */
const fileReranker = new FileReranker();

/** 已索引语料。 */
export interface IndexedCorpus {
  readonly root: string;
  /** 索引时是否启用词形归并；查询侧据此同步选择分词器（两侧须一致）。 */
  readonly morph: boolean;
  readonly symbols: readonly SymbolNode[];
  readonly files: readonly FileRecord[];
  readonly symbolIndex: Bm25Index;
  readonly fileIndex: Bm25Index;
  /** 每个符号的本征频谱（燧-3 频域召回），与 symbols 按索引一一对应。 */
  readonly symbolSpectra: readonly Spectrum[];
  /** 代码拓扑图（HippoRAG 式图检索，跨文件引用边），用于突破纯词法召回天花板。 */
  readonly codeGraph: CodeGraph;
  /** 潜语义（LSA）模型：把词与符号投影到潜空间，桥接词法错位型查询。 */
  readonly lsaModel: LsaModel;
  /** 原始文件内容（rel → text），供 baseline 计算整文件 token。 */
  readonly fileText: ReadonlyMap<string, string>;
  /**
   * 语料遍历是否**因上限被截断**（文件数 / 总字节闸）。调用方须如实转达，
   * 否则「地图只覆盖了前 N 个文件」会被误当成「这就是全部」。
   */
  readonly truncated: boolean;
  /** 因单文件超过 {@link ContextEngine.MAX_FILE_BYTES} 而未纳入符号地图的文件数（如实回报）。 */
  readonly skippedLargeFiles: number;
}

interface FileRecord {
  readonly rel: string;
  readonly tokens: number;
}

/** 索引选项：morph 开启 camelCase 拆分 + 词形变体归并（默认开，关闭即退化回 Baseline）。 */
export interface IndexOptions {
  readonly morph?: boolean;
  /**
   * light 模式（**默认开**）：跳过频域共振谱、代码图、LSA SVD 三项重索引。
   *
   * 默认值口径变更（2026-09-19）：此前默认是 **full**（`opts.light === true` 才 light），
   * 于是「不传 light」的调用方会静默吃到 full 模式一个数量级的内存代价（实测 `src/` 3 MiB
   * 语料 ⇒ 峰值 RSS 1,522 MB）。现改为 **`light !== false`**——安全档为默认，重量档必须显式关。
   * 真的需要 `corpus.codeGraph` / 频谱 / LSA 的评测脚本请显式传 `light: false`，并受
   * {@link ContextEngine.MAX_TOTAL_BYTES_FULL} 硬预算约束。
   *
   * 2026-09-05 诚实重测：三项在 omniharness 语料上实测均零增益或净负面
   * （频谱同 corpus 隔离对照纯零效应；graph −3.6pp 确认负；LSA 无增量），故生产保持禁用。
   */
  readonly light?: boolean;
  /**
   * BM25 打分参数 `k1`（词频饱和）覆盖；缺省用 `Bm25Index` 默认 1.5。
   * 索引（df / 文档长度）与 k1/b 无关，故此值仅决定两索引的构造期默认；
   * 逐次调参扫描可直接用 `query` 的 search 期覆盖，无需重建语料。
   */
  readonly bm25K1?: number;
  /** BM25 打分参数 `b`（长度归一化）覆盖；缺省用 `Bm25Index` 默认 0.75。 */
  readonly bm25B?: number;
  /** 语料遍历的文件数上限（缺省 {@link ContextEngine.MAX_FILES}）。 */
  readonly maxFiles?: number;
  /** 单文件字节上限（缺省 {@link ContextEngine.MAX_FILE_BYTES}）。 */
  readonly maxFileBytes?: number;
  /** 语料总字节预算（缺省 {@link ContextEngine.MAX_TOTAL_BYTES}）。 */
  readonly maxTotalBytes?: number;
  /** full 模式告警阈值覆盖（缺省 {@link ContextEngine.FULL_MODE_WARN_BYTES}；便于单测）。 */
  readonly fullModeWarnBytes?: number;
}

/** 单次查询结果。 */
export interface QueryResult {
  /** 紧凑上下文文本（大纲 + 命中符号签名）。 */
  readonly context: string;
  /** 上下文 token 数。 */
  readonly tokens: number;
  /** 命中的符号。 */
  readonly symbols: readonly SymbolNode[];
  /** 命中的文件（第一段按文件 BM25 排序；开启 `rerank` 时为其上的第二段重排结果）。 */
  readonly files: readonly string[];
}

/**
 * 语料级文档频率（DF）缓存：PRF 扩展词的 IDF 加权需要语料级 df，按 corpus 缓存避免每次查询重建。
 * 用 WeakMap 让 corpus 被 GC 时自动释放，不泄漏。
 *
 * @param corpus 已索引语料（含 per-file 全文 `fileText`）
 * @returns 词 → 出现该词的文档数（DF）的映射，按 corpus 单例缓存
 */
const DF_CACHE = new WeakMap<IndexedCorpus, Map<string, number>>();

/** 关键词命中 Top-N 文件的整文件 token 总和（真实竞品 baseline：grep→整文件）。 */
