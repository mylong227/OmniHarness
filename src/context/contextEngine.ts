/**
 * 无第三方依赖上下文引擎（repo-map + BM25 检索式上下文）。
 *
 * 与「整文件硬塞」或「裸 grep 整文件」相比：用结构大纲 + 相关符号签名
 * 构成紧凑上下文，在同等相关文件召回下把 token 成本压低一个数量级。
 *
 * 这是「上下文效率碾压」这一可证伪命题的真实落地模块，不依赖任何外部服务。
 */

import { Bm25Index } from '../search/bm25Index.js';
import { RepoMap, type SymbolNode } from './repoMap/repoMap.js';
import { CorpusFileParser } from './corpusFileParser.js';
import { CorpusCollector, type CollectedCorpus } from './corpusCollector.js';
import { EventLoopYield } from '../util/async/eventLoopYield.js';
import type { CorpusFileArtifact } from './corpusFileArtifact.js';
import { EigenSpectrum, RESONANCE_BINS, type Spectrum } from '../util/eigenspectrum.js';
import { CodeGraphIndex, type CodeGraph } from './codeGraphIndex.js';
import { FileReranker } from './fileReranker.js';
import { CandidateSearch } from './queryStages/candidateSearch.js';
import { SeedFusion } from './queryStages/seedFusion.js';
import { SymbolFileFusion } from './queryStages/symbolFileFusion.js';
import { PerFileSymbolView } from './queryStages/perFileSymbolView.js';
import { log } from '../util/logger.js';

export type { WalkLimits, WalkOutcome } from './corpusWalker.js';

import { CorpusWalker } from './corpusWalker.js';
import type { WalkLimits, WalkOutcome } from './corpusWalker.js';

/**
 * ContextEngine 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class ContextEngine {
  /**
   * 语料遍历相关常量与两条路径（同步 / 可让出）的**实现**已抽到 {@link CorpusWalker}（G8-c 拆类）。
   * 这里保留同名常量与同名静态方法，是为了**不改变本类的公开 API 面**（调用方与 API 快照都不用动）。
   */
  /** 单次索引最多纳入的文件数（转发 {@link CorpusWalker.MAX_FILES}）。 */
  public static readonly MAX_FILES = CorpusWalker.MAX_FILES;

  /** 单文件字节上限（转发 {@link CorpusWalker.MAX_FILE_BYTES}）。 */
  public static readonly MAX_FILE_BYTES = CorpusWalker.MAX_FILE_BYTES;

  /** 语料总字节预算（转发 {@link CorpusWalker.MAX_TOTAL_BYTES}）。 */
  public static readonly MAX_TOTAL_BYTES = CorpusWalker.MAX_TOTAL_BYTES;

  /** 全量模式总字节预算（转发 {@link CorpusWalker.MAX_TOTAL_BYTES_FULL}）。 */
  public static readonly MAX_TOTAL_BYTES_FULL = CorpusWalker.MAX_TOTAL_BYTES_FULL;

  /**
   * full 模式（频谱 / 代码图）的**告警**字节阈值（2 MiB）：超过即在日志里告警。
   *
   * 为什么只告警不阻断：生产路径（`CorpusIndexCache`）恒传 `light: true`，故这一档只服务评测脚本；
   * 一旦有人把大语料喂进 full 模式，必须**立刻在日志里看得见**，而不是等它把机器拖进 swap。
   * 这里只告警不改变行为——该档的口径由评测脚本决定，擅改会污染既有对照。
   */
  public static readonly FULL_MODE_WARN_BYTES = 2 * 1024 * 1024;

  /**
   * 同步遍历（转发 {@link CorpusWalker.walk}）。
   * @param root 遍历起点（绝对路径）。
   * @param absRoot 计算相对路径的基准（通常等于 root）。
   * @param out 结果累积数组（就地追加相对 POSIX 路径）。
   * @param limits 上限覆盖（缺省取本类常量）。
   * @returns 截断标记与「因过大被排除的文件数」。
   */
  public static walk(
    root: string,
    absRoot: string,
    out: string[],
    limits: WalkLimits = {},
  ): WalkOutcome {
    return CorpusWalker.walk(root, absRoot, out, limits);
  }

  /**
   * **可让出**的目录遍历（转发 {@link CorpusWalker.walkAsync}，G8-c）。
   * @param root 遍历起点（绝对路径）。
   * @param absRoot 计算相对路径的基准（通常等于 root）。
   * @param out 结果累积数组（就地追加相对 POSIX 路径）。
   * @param limits 上限覆盖（缺省取本类常量）。
   * @param chunkEntries 让出粒度（跨目录累计的目录项数）。
   * @returns 截断标记与「因过大被排除的文件数」。
   */
  public static async walkAsync(
    root: string,
    absRoot: string,
    out: string[],
    limits: WalkLimits = {},
    chunkEntries: number = CorpusWalker.WALK_ASYNC_CHUNK_ENTRIES,
  ): Promise<WalkOutcome> {
    return CorpusWalker.walkAsync(root, absRoot, out, limits, chunkEntries);
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
    // 解析规则（分词 / 抽符号 / 文档组装）只有一份实现：全量路径与增量重建器共用
    // `CorpusFileParser`，否则两处一旦漂移，增量语料与全量语料会给出不同检索结果（且不报错）。
    const parser = new CorpusFileParser(opts.morph !== false);
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
    const { truncated, skippedLargeFiles } = walked;
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
        log.warn('indexCorpus 以 full 模式索引较大语料（频谱 / 代码图），峰值内存可达 GB 级', {
          root,
          corpusMiB: Number((walked.totalBytes / 1048576).toFixed(2)),
          budgetMiB: Number((budget / 1048576).toFixed(2)),
          advice:
            '生产路径请传 light: true（CorpusIndexCache 已如此）；full 仅用于小语料的对照评测',
        });
      }
    }
    const { fileText, fileRecords, fileDocs, allSymbols, symbolDocs } = ContextEngine.collectCorpus(
      root,
      files,
      parser,
      opts.artifactSink,
    );
    return ContextEngine.assembleCorpus(root, {
      opts,
      light,
      truncated,
      skippedLargeFiles,
      collected: { fileText, fileRecords, fileDocs, allSymbols, symbolDocs },
    });
  }

  /**
   * **可让出事件循环**的语料索引（G8，2026-10-03）：与 {@link indexCorpus} **逐位相同**的产物，
   * 但把逐文件解析切成块，每块之间交回宏任务（{@link EventLoopYield.turn}）。
   *
   * 为什么需要：实测 `indexCorpus` 在 `src/`（919 文件）上单次约 **1.4 s** 全在同步段里跑完，
   * 期间定时器/HTTP 回调/日志 flush 全部阻塞（`monitorEventLoopDelay().max` 飙到秒级）——
   * 交互路径上语料重建会让服务端"卡住一下"。切片后单块约 50 ms。
   *
   * 正确性依据：两条路径共用 {@link CorpusCollector}（累积状态与符号编号口径只有一份实现），
   * 故产物逐位相同（`tests/unit/corpusIndexAsync.test.ts` 对同一子树做深度相等断言）。
   * @param root 工作区根（绝对路径）。
   * @param opts 索引选项（与 `indexCorpus` 同）。
   * @param chunkFiles 每块文件数（缺省 {@link EventLoopYield.DEFAULT_CHUNK}）。
   * @returns 与 `indexCorpus` 等价的语料。
   */
  public static async indexCorpusAsync(
    root: string,
    opts: IndexOptions = {},
    chunkFiles: number = EventLoopYield.DEFAULT_CHUNK,
  ): Promise<IndexedCorpus> {
    const parser = new CorpusFileParser(opts.morph !== false);
    const light = opts.light !== false;
    const files: string[] = [];
    const budget =
      opts.maxTotalBytes ??
      (light ? ContextEngine.MAX_TOTAL_BYTES : ContextEngine.MAX_TOTAL_BYTES_FULL);
    // G8-c（2026-10-03）：遍历也走**可让出**档（原先这里是同步 `walk`，`src/` 上实测 54 ms 不让出，
    // 让"单次不让出超过 100 ms"这个上限收不回来）。状态构造共用 `buildWalkState` ⇒ 闸门口径一致。
    const walked = await ContextEngine.walkAsync(root, root, files, {
      ...(opts.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {}),
      ...(opts.maxFileBytes !== undefined ? { maxFileBytes: opts.maxFileBytes } : {}),
      maxTotalBytes: budget,
    });
    ContextEngine.assertFullModeBudget(light, walked.truncated, opts);
    const collector = new CorpusCollector();
    const chunk = Math.max(1, Math.floor(chunkFiles));
    for (let start = 0; start < files.length; start += chunk) {
      for (const rel of files.slice(start, start + chunk)) {
        collector.addFile(root, rel, parser, opts.artifactSink);
      }
      await EventLoopYield.turn();
    }
    const collected = collector.result();
    // 装配段同样要分块：实测 `src/`（922 文件）里"文件级 BM25 建索引"单独就是 **730 ms**
    // （正文侧文档很长），只切解析段仍会留下一个远超阈值的同步尾巴。
    const indexes = await ContextEngine.buildBm25Chunked(opts, collected);
    return ContextEngine.assembleCorpus(root, {
      opts,
      light,
      truncated: walked.truncated,
      skippedLargeFiles: walked.skippedLargeFiles,
      collected,
      indexes,
    });
  }

  /**
   * 分块（可让出事件循环）构建两个 BM25 索引。
   *
   * 为什么分块粒度不同：符号文档短（10,631 篇共 89 ms），文件文档长（922 篇共 **730 ms**）
   * ⇒ 前者每块 256 篇、后者每块 16 篇，使单块耗时都落在十几毫秒量级。
   * 与同步路径**同产物**：`addDocument` 是**追加**语义（槽位 = 追加前文档数），故分块喂入
   * 与一次性喂入得到逐位相同的索引状态（`tests/unit/nativeTokenAndYield.test.ts` 断言两路等价）。
   * @param opts 索引选项（取 k1/b 口径）。
   * @param collected 已累积的语料件。
   * @returns 两个已建好的索引（符号级 / 文件级）。
   */
  private static async buildBm25Chunked(
    opts: IndexOptions,
    collected: CollectedCorpus,
  ): Promise<{ readonly symbolIndex: Bm25Index; readonly fileIndex: Bm25Index }> {
    const init = ContextEngine.bm25InitOf(opts);
    const symbolIndex = new Bm25Index(init);
    for (let start = 0; start < collected.symbolDocs.length; start += 256) {
      symbolIndex.addDocuments(collected.symbolDocs.slice(start, start + 256));
      await EventLoopYield.turn();
    }
    const fileIndex = new Bm25Index(init);
    for (let start = 0; start < collected.fileDocs.length; start += 16) {
      fileIndex.addDocuments(collected.fileDocs.slice(start, start + 16));
      await EventLoopYield.turn();
    }
    return { symbolIndex, fileIndex };
  }

  /**
   * BM25 初始化参数（`exactOptionalPropertyTypes`：仅装配显式提供的参数，缺省交由 `Bm25Index` 自身默认）。
   *
   * 抽出的动因：同步与分块两条路径必须用**同一份** k1/b 口径，否则两条路径会建出不同的索引
   * （而且不会报错，只会让检索结果悄悄分叉）。
   * @param opts 索引选项。
   * @returns BM25 构造参数（缺省为空对象，即库默认 1.5 / 0.75）。
   */
  private static bm25InitOf(opts: IndexOptions): { k1?: number; b?: number } {
    return {
      ...(opts.bm25K1 !== undefined ? { k1: opts.bm25K1 } : {}),
      ...(opts.bm25B !== undefined ? { b: opts.bm25B } : {}),
    };
  }

  /**
   * full 档的语料预算护栏（同步/异步两条索引路径共用，避免两份判定漂移）。
   *
   * full 模式的每字节代价比 light 高一个数量级，大语料必须**拒跑**而不是"静默只索引一半"——
   * 半份语料会给出错误的对照结论。
   * @param light 是否 light 档。
   * @param truncated 遍历是否因预算被截断。
   * @param opts 索引选项（显式预算时不再拒跑）。
   * @returns 无返回值；越界时抛错。
   */
  private static assertFullModeBudget(
    light: boolean,
    truncated: boolean,
    opts: IndexOptions,
  ): void {
    if (light) {
      return;
    }
    const explicitBudget = opts.maxTotalBytes !== undefined;
    if (truncated && !explicitBudget) {
      throw new Error(
        `full 模式语料超过预算（${String(ContextEngine.MAX_TOTAL_BYTES_FULL)} 字节）：` +
          '生产路径请传 light: true（CorpusIndexCache 已如此）；full 仅用于小语料的对照评测',
      );
    }
  }

  /**
   * 由累积好的语料件装配索引（BM25 / 频谱 / 代码图）。
   *
   * 抽出的动因：让**同步**与**可让出的异步**两条索引路径共用同一段"建索引"逻辑——
   * 否则两份装配一旦漂移，同一份语料会给出不同检索结果（且不报错）。
   * @param root 工作区根。
   * @param parts 装配输入（选项、档位、截断标记、累积好的语料件，以及**可选的预建 BM25 索引**）。
   * @returns 可查询语料。
   */
  private static assembleCorpus(
    root: string,
    parts: {
      readonly opts: IndexOptions;
      readonly light: boolean;
      readonly truncated: boolean;
      readonly skippedLargeFiles: number;
      readonly collected: CollectedCorpus;
      /** 预建索引（分块路径注入）；缺省则在本次装配里同步建（与之一致）。 */
      readonly indexes?: { readonly symbolIndex: Bm25Index; readonly fileIndex: Bm25Index };
    },
  ): IndexedCorpus {
    const { opts, light, truncated, skippedLargeFiles, collected, indexes } = parts;
    const { fileText, fileRecords, fileDocs, allSymbols, symbolDocs } = collected;

    // 索引来源：分块路径注入（已建好，避免再同步建一遍）；同步路径就地建。
    const symbolIndex = indexes?.symbolIndex ?? new Bm25Index(ContextEngine.bm25InitOf(opts));
    const fileIndex = indexes?.fileIndex ?? new Bm25Index(ContextEngine.bm25InitOf(opts));
    if (indexes === undefined) {
      symbolIndex.addDocuments(symbolDocs);
      fileIndex.addDocuments(fileDocs);
    }

    // 燧-3 频域索引：每个符号的名/类/签名映射到本征频谱，用于共振召回（与 BM25 时域/词袋互补）。
    // light 模式跳过（2026-09-05 诚实重测：同 corpus「频谱开/关」隔离对照，文件召回 41.4% = 41.4%
    // —— 纯零效应；此前某次「+2.5pp」是 full vs light 两语料混淆对比的假象）。频域共振/图 两项
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
      truncated,
      skippedLargeFiles,
    };
  }

  /**
   * 逐文件解析并累积语料件（**同步**驱动；与 {@link indexCorpusAsync} 共用 {@link CorpusCollector}）。
   *
   * 为什么要共用累积器：符号编号是**跨文件连续**的（`artifact()` 需要"我之前的符号总数"）。若让
   * 异步切片路径另写一份循环，两份实现一旦漂移，同步语料与异步语料会给出**不同的检索结果且不报错**。
   * @param root 工作区根（绝对路径）。
   * @param files 待解析的相对 POSIX 路径（按遍历顺序）。
   * @param parser 单文件解析器（与增量重建器共用同一实现）。
   * @param sink 产物接收器（可选）。
   * @returns 累积出的语料件（正文表 / 文件记录 / 两个 BM25 文档集 / 符号表）。
   */
  private static collectCorpus(
    root: string,
    files: readonly string[],
    parser: CorpusFileParser,
    sink: Map<string, CorpusFileArtifact> | undefined,
  ): CollectedCorpus {
    const collector = new CorpusCollector();
    for (const rel of files) {
      collector.addFile(root, rel, parser, sink);
    }
    return collector.result();
  }

  /**
   * 检索式上下文（混合打分版）：
   * 每个文件的得分 = max(文件BM25分, 0.7 × 该文件内最强符号BM25分)。
   * 这样既保留文件级语义，又能把「文件级弱命中但含强相关符号」的文件（如 registerTool）
   * 捞回 Top-K，并在固定文件数上限内给出紧凑上下文——召回与压缩兼得。
   *
   * `opts.rerank: true` 时在上述第一段之后追加**第二段无第三方依赖词法精排**
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
      layered?: boolean;
      fileK?: number;
      symK?: number;
      /** BM25 `k1` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
      bm25K1?: number;
      /** BM25 `b` 的打分期覆盖（调参扫描用）；缺省用索引构造期取值。 */
      bm25B?: number;
      /**
       * 第二段重排（无第三方依赖词法精排，见 `FileReranker`）。默认 **false**：
       * `query()` 的既有调用方（基准脚本 / 单测，冻结过报告口径）零行为变更；
       * 生产入口 `RepoMapContextEngine.getRepoMapContext` 显式传 true。
       */
      rerank?: boolean;
      /**
       * 重排的头部地板个数（把第一段前 N 个候选钉在原位）。**缺省 0（不设地板）**，仅在
       * `rerank: true` 时生效。口径更正（2026-09-26 审计 R8）：此处原写「缺省交由
       * FileReranker 按 round(fileK/3) 决定」，而 resolveFloor 实际返回 0 —— 文档承诺的默认
       * 值从未存在过；现按事实改写，并在生产路径补上转发。
       */
      rerankFloor?: number;
    } = {},
  ): QueryResult {
    // 各路默认关闭的实测依据（graph/layered）随实现迁入对应阶段类的文件头，
    // 开关语义与评测口径不变：graph/layered 均为评测专用，生产默认全关。
    // LSA 潜语义路已于 G19（2026-10-03）**整体删除**：实测「召回持平 / 无增量」⇒ 不值得继续维护。
    const useGraph = opts.graph === true;
    const useLayered = opts.layered === true;
    const useRerank = opts.rerank === true;
    const FILE_K = opts.fileK ?? 14;
    const SYM_K = opts.symK ?? 30;

    // 阶段 1：候选搜索（BM25 双路 + PRF 扩展重跑）。
    const search = CandidateSearch.search(corpus, q, {
      ...(opts.prf !== undefined ? { prf: opts.prf } : {}),
      ...(opts.bm25K1 !== undefined ? { bm25K1: opts.bm25K1 } : {}),
      ...(opts.bm25B !== undefined ? { bm25B: opts.bm25B } : {}),
    });
    // 阶段 2：种子融合（BM25 ∪ 频域共振 → 扩散重启向量）。
    const fused = SeedFusion.fuse(corpus, q, { symK: SYM_K }, search.bm25SymHits);
    // 阶段 3：符号-文件融合（图扩散/基线 → 文件混合分 → 完整候选池）。
    const spread = SymbolFileFusion.fuse(
      corpus,
      { graph: useGraph, layered: useLayered },
      fused.seed,
      fused.symIdSet,
      search.fileHits,
    );

    // 第二段：重排（默认关）。重排只重排入池文件，不新增/删除候选。
    const rankedFiles = useRerank
      ? [
          ...fileReranker.rerank({
            corpus,
            query: q,
            candidates: spread.candidateFiles,
            fileK: FILE_K,
            ...(opts.rerankFloor !== undefined ? { floor: opts.rerankFloor } : {}),
          }).files,
        ]
      : spread.candidateFiles.slice(0, FILE_K);

    const symbols = [...fused.symIdSet]
      .map((id) => ({ s: corpus.symbols[id], v: spread.finalScores[id] ?? 0 }))
      .filter((x): x is { s: SymbolNode; v: number } => x.s !== undefined)
      .sort((a, b) => b.v - a.v)
      .slice(0, SYM_K)
      .map((x) => x.s);

    // 大纲：每文件符号视图按候选集重建（免全量扫符号表；输出与 filter 逐字节一致）。
    const outline = RepoMap.outlineText(
      PerFileSymbolView.of(corpus).inSetOrder(new Set(rankedFiles)),
    );
    const sigLines = symbols.map((s) => `L${s.line} ${s.kind} ${s.name} @ ${s.file}`);
    const context = [
      '# Repo Map (relevant files)',
      outline,
      '# Relevant Symbols',
      ...sigLines,
    ].join('\n');

    return { context, tokens: Bm25Index.tokenize(context).length, symbols, files: rankedFiles };
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
   * light 模式（**默认开**）：跳过频域共振谱、代码图两项重索引。
   *
   * 默认值口径变更（2026-09-19）：此前默认是 **full**（`opts.light === true` 才 light），
   * 于是「不传 light」的调用方会静默吃到 full 模式一个数量级的内存代价（实测 `src/` 3 MiB
   * 语料 ⇒ 峰值 RSS 1,522 MB）。现改为 **`light !== false`**——安全档为默认，重量档必须显式关。
   * 真的需要 `corpus.codeGraph` / 频谱的评测脚本请显式传 `light: false`，并受
   * {@link ContextEngine.MAX_TOTAL_BYTES_FULL} 硬预算约束。
   *
   * 2026-09-05 诚实重测：三项在 omniharness 语料上实测均零增益或净负面
   * （频谱同 corpus 隔离对照纯零效应；graph −3.6pp 确认负），故生产保持禁用。
   * LSA 路已于 G19 删除（同一批实测：召回持平、无增量）。
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
  /**
   * 产物接收器（可选）：全量索引时把**逐文件解析产物**写进这张表，供
   * `CorpusIncrementalUpdater` 后续增量重建时按内容哈希复用（省掉重复的分词与抽符号）。
   *
   * 为什么由调用方传表而不在引擎内缓存：产物的生命期与**语料缓存条目**一致
   * （`CorpusIndexCache` 的 LRU 条目），引擎自身无状态、不得持有跨调用状态。
   */
  readonly artifactSink?: Map<string, CorpusFileArtifact> | undefined;
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

/** 关键词命中 Top-N 文件的整文件 token 总和（真实竞品 baseline：grep→整文件）。 */
