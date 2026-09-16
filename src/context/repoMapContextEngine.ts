/**
 * repo-map 生产接入器（U2）：把已实测的上下文引擎接到真实 agent 循环。
 *
 * 设计要点：
 *  - 进程级按 workspace 根路径缓存索引，避免每个 step 重扫全仓；TTL 默认 30s，任一时段至多一次重索引，
 *    规避「agent 改文件 → 根 mtime 变 → 每步重索引」的风暴。（缓存职责在 `CorpusIndexCache`）
 *  - 任何异常（坏路径 / 空仓 / 索引失败 / 查询失败 / 禁用）→ 返回 null，绝不抛错崩 agent。
 *  - 索引强制 light 模式：仅 morph + 符号/文件双 BM25，跳过频域共振 / 44 万边代码图 / LSA SVD
 *    （三项在 omniharness 语料实测均零增益）。召回配置即基准里 67.0% 那档。
 *  - **两阶段检索（打磨第二批 P1）**：第一段之后追加**零依赖词法精排**
 *    （`FileReranker`：符号名 IDF 加权覆盖率 + 第一段倒数秩）。**2026-09-17 起默认开**——
 *    与检索预算**耦合**，见下节。关闭：`opts.rerank = false`。
 *    **同日混合（语义）路径也接上了第二段**：旧注释曾写「语义路需嵌入模型，离线无法度量，
 *    按『不报未测数字』纪律留给可测时再定」。模型通道打通后实测：纯混合 **75.8%** →
 *    混合+精排 **81.8%**（33 条对抗锚点，2 条捞回 / 0 条丢失），注入 token 反降 16.8%。
 *    候选池必须用**未截断**的 `ranked.allFiles`——先截到 fileK 会让重排无余地（差 9.1pp）。
 *
 * 检索预算、精排与载荷投送默认档（2026-09-17 两轮决策）：
 *  - **第一轮**：fileK 默认 **10 → 14**、精排默认 **关 → 开** 是**同一个决策**：精排增益随候选池深度
 *    放大，此前「不翻默认」的真因不是重排器无用，而是**预算太浅让它施展不开**（`evals/rerank-ab.mjs`
 *    早已指出）。实测（33 条对抗锚点查询，bootstrap 95% CI）：旧默认（K=10，无精排）**51.5%**
 *    → K=10+精排 54.5% [36.4, 69.7] → **K=14+精排 69.7% [54.5, 84.8]**。
 *  - **第二轮**：fileK **14 → 20**，由**载荷梯度投送**（{@link RepoMapPayload}）买单。
 *    此前不敢扩档的唯一理由是「token 再翻一倍」（K=20 全大纲 4886 token）；梯度投送把同一批
 *    20 个文件的注入压到 **1496 token（−69.4%）**——**比原来的 K=14 全大纲（3703）还少 59.6%**，
 *    而命中率由 69.7% 升到 **75.8% [60.6, 87.9]**。即「扩覆盖」与「降成本」同时达成。
 *  - **构造性保证**：梯度投送**不改变文件集合**（33/33 查询逐字相同），故 `hitRate@K` 必然不降；
 *    它改变的是注入的**字面信息量**。回退：`opts.payloadShape='full'` 或 env `OMNI_PAYLOAD=full`。
 *  - **口径边界（诚实登记）**：75.8% 是**对抗口径**——那批查询刻意避开锚点字面词。
 *    同批锚点在**自然口径**（用户直接说出符号名）下命中率 **97% [90.9, 100]**（`evals/spider-final-ab.mjs`），
 *    即生产现实下检索已近饱和；对抗口径的剩余差距主体是**语义鸿沟**，零依赖手段已系统性证伪（见
 *    `docs/RECALL_HEADROOM_SURVEY.md`「蜘蛛网五形态」节）。另：梯度投送对**下游任务完成率**的影响
 *    **未经验证**，须待 P6 端到端基准——本模块不作承诺（见 `RepoMapPayload` 模块头「诚实边界」）。
 *  - **本轮系统性证伪（勿重复投入）**：多字段 BM25F（雷达四频段）、RRF 多探针融合的**命中率**增益
 *    在 n=33 下**均不显著**（配对 bootstrap CI 跨 0：+6.06pp [−6.06, 18.18] / +0pp [−12.12, 12.12]），
 *    故**不落地生产代码**；详见 `evals/military-verdict.report.json`。
 *
 * 混合检索（语义召回，U3 残留的词法盲区补强）：
 *  - `getRepoMapContext` 保持同步、纯 BM25（零破坏、既有测试不变）。
 *  - `getHybridRepoMapContext` 在传入 EmbeddingPort 时启用：BM25 命中 ∪ 语义向量召回，
 *    经 RRF 融合后产出上下文。模型缺失/离线/嵌入抛错 → 回落纯 BM25（fail-closed）。
 *  - 默认关：仅当运行时注入 embedding（env OMNI_SEMANTIC_RECALL=1 构造适配器）才走混合路径，
 *    不增 config schema，也避免默认加载 80MB 模型拖累每个 step。
 *
 * 架构（OOP 收敛，2026-09-11）：本类现为**薄编排门面**，把四类职责委派给独立协作者（各有专属文件、
 * 文件名=类名）——`RecallKnobs`（旋钮解析）/ `CorpusIndexCache`（语料缓存）/ `SemanticIndexCache`
 * （语义索引构建与缓存）/ `HybridRanker`（RRF 融合排序）。本类只负责「取语料 → 取旋钮 → 取索引 →
 * 检索 → 交给 ranker → 格式化」的编排，职责单一、易测易维护。
 * 为不触碰热区文件 `src/core/stepRunner.ts`（Agent Loop V2 会话活跃）的调用点，仍导出同名函数作为
 * 单例 `repoMapContextEngine` 的薄包装；新调用方应直接用引擎实例。
 */

import { query, type IndexedCorpus } from './contextEngine.js';
import { RepoMapPayload, type RepoMapPayloadPlan } from './repoMapPayload.js';
import { tokenize, tokenizeExpanded } from '../search/bm25Index.js';
import type { RecallItem } from './semanticIndex.js';
import { clearGraphSignal } from './codeReferenceGraph.js';
import type { EmbeddingPort } from '../ports/model/embedding.js';
import { RecallKnobs, type RepoMapContextOptions } from './recallKnobs.js';
import { CorpusIndexCache } from './corpusIndexCache.js';
import { SemanticIndexCache } from './semanticIndexCache.js';
import { HybridRanker, type RankedRepoMap } from './hybridRanker.js';
import { FileReranker } from './fileReranker.js';

// 公开符号再导出（保持原 `repoMapContext.ts` 的对外 API 表面不变）。
export type { RepoMapContextOptions } from './recallKnobs.js';
export { CHUNK_BODY_MAX_LINES } from './semanticIndexCache.js';

/** BM25 检索的候选数：符号路 / 文件路各取多少再交给融合。 */
const BM25_SYM_CANDIDATES = 60;
/** BM25 文件路候选数。 */
const BM25_FILE_CANDIDATES = 20;
/** 语义路单次召回的候选数。 */
const SEMANTIC_CANDIDATES = 40;
/**
 * 生产检索预算（fileK）默认值。
 *
 * **2026-09-17 由 10 → 14 → 20**（两轮决策，依据见文件头「检索预算与刚度投送」节）：
 *  - 第一轮 10 → 14：`fileK=14 + 精排` 命中率 **69.7%**（CI [54.5, 84.8]），下界 > 旧默认 51.5%；
 *  - 第二轮 14 → 20：**由载荷梯度投送买单**——注入 token 从 3703 压到 1496（−59.6%），
 *    省下的预算覆盖更深的文件，命中率 **75.8%**（CI [60.6, 87.9]），而 token 仍低于原 fileK=14 全大纲口径。
 */
const DEFAULT_FILE_K = 20;

/**
 * repo-map 检索引擎——混合检索的编排门面（Facade）。
 *
 * 组合根：构造时装配 `CorpusIndexCache` / `SemanticIndexCache` / `HybridRanker` 三个协作者，
 * 并把「语料缓存驱逐」与「语义缓存失效」通过回调解耦地连起来。进程级共享单例见文件底部。
 */
export class RepoMapContextEngine {
  /** 语义索引缓存（先于 corpusCache 构造，供其驱逐回调引用）。 */
  private readonly semanticCache = new SemanticIndexCache();
  /**
   * 语料索引缓存；某 root 被 LRU 驱逐时，同步失效该 root 的语义索引（避免陈旧索引残留）。
   * 注：旧实现用 `semanticCache.delete(root)` 因键不匹配实为空操作，此处经回调修正为按 root 全变体失效。
   */
  private readonly corpusCache = new CorpusIndexCache({
    onEvict: (root) => this.semanticCache.clear(root),
  });
  /** 多路召回融合排序器（无状态，可复用）。 */
  private readonly ranker = new HybridRanker();
  /** 第二段零依赖词法精排（无状态；内部词法视图按语料惰性缓存）。 */
  private readonly fileReranker = new FileReranker();

  /**
   * 解析载荷档位计划（三级：opts > env > 默认 tiered）。
   * @param shape 调用方显式形态；缺省时读 env `OMNI_PAYLOAD`（`full` 才回退）
   * @returns 档位计划；`null` 表示历史全大纲口径（逐字复现）
   */
  private static payloadPlanOf(
    shape: 'full' | 'tiered' | 'degrade' | undefined,
  ): RepoMapPayloadPlan | null {
    const resolved = shape ?? (process.env.OMNI_PAYLOAD === 'full' ? 'full' : 'tiered');
    if (resolved === 'full') return null;
    return resolved === 'degrade' ? RepoMapPayload.DEGRADE_PLAN : RepoMapPayload.DEFAULT_PLAN;
  }

  /**
   * 产出可注入 system 消息的 repo-map 上下文文本（纯 BM25，同步、零破坏）。
   * 任意失败路径均返回 null（调用方据此跳过注入，不影响主流程）。
   * @param root workspace 根路径。
   * @param q 查询文本。
   * @param opts 选项（enabled=false 直接跳过）。
   * @returns 上下文文本，或 null（禁用 / 空查询 / 索引失败）。
   */
  public getRepoMapContext(
    root: string,
    q: string,
    opts: RepoMapContextOptions = {},
  ): string | null {
    if (opts.enabled === false) {
      return null;
    }
    if (root === undefined || root === '' || q.trim() === '') {
      return null;
    }
    const corpus = this.corpusCache.get(root);
    if (corpus === null) {
      return null;
    }
    try {
      // 注：`query()` 的历史第 3 位置参数（候选数）已于 2026-09-16 移除——它从不被读取，
      // 本处原传的 `BM25_ONLY_CANDIDATES`(=20) 与 `query` 内部固定候选上限（文件 20 / 符号 60）一致，故删除不改变行为。
      const res = query(corpus, q, {
        graph: false,
        lsa: false,
        layered: opts.layered === true,
        fileK: opts.fileK ?? DEFAULT_FILE_K,
        symK: opts.symK ?? 24,
        // 第二段零依赖词法重排（打磨第二批 P1）：**2026-09-17 起默认开**。
        // 为什么此刻翻默认：本档与预算档是**耦合**的——精排的增益取决于候选池深度。
        //   · fileK=10（旧默认）：26.9%→33.2% 召回，CI95 [−0.45, 14.74]pp 下界跨 0 ⇒ 未过阈值；
        //   · fileK=14（新默认）：33 条对抗锚点查询命中率 51.5%→69.7%，CI95 [54.5, 84.8] 下界超基线 ⇒ 两关全过。
        // 即：此前不翻默认不是「重排器不行」，而是**预算太浅让重排施展不开**（rerank-ab 报告结论）。
        // 关闭：`opts.rerank = false` 或 env `OMNI_RERANK=0`（用 !== '0' 而非 === '1'：默认开、显式 0 关）。
        rerank: opts.rerank ?? process.env.OMNI_RERANK !== '0',
        // 伪相关反馈（PRF / RM3 风格查询扩展）：**默认关（opt-in）**——突破纯词法召回天花板。
        // 实测（`evals/recall-precision.mjs`，33 条锚点查询）fileK=5/10 档提升准确度 +0.9~4.3pp、
        // 召回 +2.8~7.9pp、命中率持平；仅 fileK=14 命中率略降。命中率未过两关阈值、K=14 略回退 ⇒ 不翻默认。
        // 与 P5 预算降档（fileK=5）天然互补：降档后 token 更紧，PRF 精度/召回增益最显著。
        // 开启：`opts.prf = true` 或 env `OMNI_RM3=1`；显式 `false` / `OMNI_RM3=0` 关闭（?? 非 ||）。
        prf: opts.prf ?? process.env.OMNI_RM3 === '1',
      });
      // 载荷投送（RepoMapPayload）：命中哪些文件由**排序**决定，注入多少字由**呈现**决定。
      // 梯度投送把注入 token 压降 60~70% 而**文件集合逐字不变**（构造性，33/33 实测）。
      // tiered 默认开；'full' 回退历史口径、'degrade' 为软预算应急压缩档。
      return RepoMapPayload.assemble(
        { corpus, files: res.files, symbols: res.symbols, query: q },
        RepoMapContextEngine.payloadPlanOf(opts.payloadShape),
      );
    } catch {
      return null;
    }
  }

  /**
   * 混合检索版 repo-map 上下文（BM25 ∪ 语义向量，RRF 融合）。
   * 仅在调用方传入有效 EmbeddingPort 时启用；任意嵌入/召回异常 → 回落纯 BM25（fail-closed），
   * 绝不因语义层失败而崩主流程或丢上下文。
   * @param root workspace 根路径。
   * @param q 查询文本。
   * @param embedding 嵌入端口。
   * @param opts 选项。
   * @returns 上下文文本，或 null（空查询 / 索引失败且 BM25 回退亦失败）。
   */
  public async getHybridRepoMapContext(
    root: string,
    q: string,
    embedding: EmbeddingPort,
    opts: RepoMapContextOptions = {},
  ): Promise<string | null> {
    if (root === '' || q.trim() === '') {
      return null;
    }
    const corpus = this.corpusCache.get(root);
    if (corpus === null) {
      return null;
    }
    try {
      // 旋钮一次性解析并冻结（快照语义），供索引构建与融合共用，避免散落的 env 读取。
      const knobs = new RecallKnobs(opts);
      const idx = await this.semanticCache.get(root, corpus, embedding, knobs);
      const { bm25SymIds, bm25FileIds } = this.retrieveLexical(corpus, q);
      const semanticHits = await idx.search(q, SEMANTIC_CANDIDATES);
      const ranked = this.ranker.rank({
        root,
        corpus,
        knobs,
        bm25SymIds,
        bm25FileIds,
        semanticHits,
      });
      // 第二段精排（2026-09-17 接入）：本路径此前**明确未接**第二段，理由写在旧注释里——
      // 「语义路需嵌入模型，离线无法度量，按『不报未测数字』纪律留给可测时再定」。
      // 本轮模型通道打通（hf-mirror 可达 + 适配器补 `remoteHost` 旋钮）后已可度量：
      //   33 条对抗锚点查询 纯混合 **75.8%** → 混合+精排 **81.8%**（2 条捞回、0 条丢失），
      //   且注入 token 更低（1191 vs 1431，−16.8%）。
      // 注意候选池必须用 `ranked.allFiles`（**未截断**的完整融合排名），而不是 `ranked.files`：
      // 重排只能在入池候选里换位，池子先截到 fileK 会让重排无余地（实测该口径差 9.1pp）。
      // 关闭：`opts.rerank = false` 或 env `OMNI_RERANK=0`（与纯 BM25 路径同一解析口径）。
      const useRerank = opts.rerank ?? process.env.OMNI_RERANK !== '0';
      const files = useRerank
        ? this.fileReranker.rerank({
            corpus,
            query: q,
            candidates: ranked.allFiles,
            fileK: knobs.fileK,
          }).files
        : ranked.files;
      return this.formatContext(
        { files, allFiles: ranked.allFiles, symbols: ranked.symbols },
        corpus,
        q,
        RepoMapContextEngine.payloadPlanOf(knobs.payloadShape),
      );
    } catch {
      // fail-closed：语义层失败 → 回落纯 BM25 上下文。
      return this.getRepoMapContext(root, q, opts);
    }
  }

  /**
   * 手动失效缓存（某个 workspace 文件结构剧变时调用，可选）。同时清语义索引缓存与图信号缓存。
   * @param root 指定则只失效该工作区；缺省清空全部（不含图信号，图按 workspace 独立缓存）。
   
 * @returns 无返回值。
*/
  public clear(root?: string): void {
    this.corpusCache.clear(root);
    this.semanticCache.clear(root);
    if (root !== undefined) {
      // P5 稀疏引用图按 root 缓存，文件结构剧变须同步失效。
      clearGraphSignal(root);
    }
  }

  /**
   * 分块语义召回项构造（对外暴露供单测；实现委派 `SemanticIndexCache`）。
   * @param corpus 已索引语料。
   * @returns 分块召回项。
   */
  public buildChunkItems(corpus: IndexedCorpus): RecallItem[] {
    return this.semanticCache.buildChunkItems(corpus);
  }

  /**
   * BM25 词法检索：产出符号路 / 文件路命中 id。
   * @param corpus 已索引语料。
   * @param q 查询文本。
   * @returns `sym:<i>` 与 `file:<rel>` 两组命中 id。
   */
  private retrieveLexical(
    corpus: IndexedCorpus,
    q: string,
  ): { bm25SymIds: string[]; bm25FileIds: string[] } {
    const tk = corpus.morph ? tokenizeExpanded(q) : tokenize(q);
    const bm25SymIds = [...corpus.symbolIndex.search(tk, BM25_SYM_CANDIDATES)].map(
      (h) => `sym:${h.id}`,
    );
    const bm25FileIds = [...corpus.fileIndex.search(tk, BM25_FILE_CANDIDATES)]
      .map((h) => corpus.files[h.id]?.rel)
      .filter((rel): rel is string => rel !== undefined)
      .map((rel) => `file:${rel}`);
    return { bm25SymIds, bm25FileIds };
  }

  /**
   * 把融合结果格式化为可注入 system 消息的上下文文本（委派 `RepoMapPayload` 的载荷策略，
   * 与纯 BM25 路径同一套呈现口径：档位计划 / 历史全大纲）。
   * @param ranked 融合排序结果（入选文件 + 符号）。
   * @param corpus 已索引语料（用于取入选文件的 outline）。
   * @param q 查询原文（梯度投送据此挑选中段档要显示的命中符号名）。
   * @param plan 档位计划；`null` = 历史全大纲口径。
   * @returns 上下文文本。
   */
  private formatContext(
    ranked: RankedRepoMap,
    corpus: IndexedCorpus,
    q: string,
    plan: RepoMapPayloadPlan | null,
  ): string {
    return RepoMapPayload.assemble(
      { corpus, files: ranked.files, symbols: ranked.symbols, query: q },
      plan,
    );
  }
}
