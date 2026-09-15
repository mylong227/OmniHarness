/**
 * 文件重排器（FileReranker）——零依赖**两阶段检索的第 2 段**（精排）。
 *
 * ## 为什么需要第 2 段
 *
 * 第一段（BM25 文件路 ∪ 符号路）是**词袋**打分：它把「查询词在文件里出现过几次」和
 * 「查询词是不是这个文件**定义**的标识符」当成同一件事。于是同一批候选里，
 * 「顺带提及 query 词」的大文件会盖住「恰好就是定义处」的小文件——Top-K 预算被稀释，
 * 命中准率上不去。行业做法是加一段**精排**：retriever 定上限、refine 补精确。
 *
 * ## 打分式（**无自由参数**，非拟合产物）
 *
 * ```text
 * score(file) = 1 / (1 + 第一段名次)      ← 保留第一段排序信息（倒数秩，RRF 同族）
 *             + 符号名 IDF 加权覆盖率      ← 第二个独立信号（区间 [0,1]）
 * ```
 *
 * 覆盖率定义为：
 *
 * ```text
 * coverage = Σ_{t ∈ 查询内容词 ∩ 该文件声明符号名词集} w(t)  /  Σ_{t ∈ 查询内容词} w(t)
 * ```
 *
 * `w(t)` = 该词在文件索引上的 IDF（与第一段同源）。语义是「**这个文件定义的东西**
 * 覆盖了查询里多少（按稀有度加权）内容」——而不是它顺带写了多少。
 *
 * 两项的量纲由构造决定：倒数秩在名次 1 处为 0.5、名次 ≥ 14 时低于 0.067，覆盖率在 [0,1]
 * ——即「符号名覆盖」力压「第一段已排到 14 名开外」的名次差，但压不过名次 1 加上近满分覆盖。
 * 本式**全无待定系数**（倒数秩的 `k=1` 与 IDF 均由既有检索口径给定），故不存在「为达标而调参」
 * 的口径风险；选型依据见下方「实测」。
 *
 * ## 头部地板（可选，**默认 0 = 不设**）
 *
 * `floor` 允许把第一段前 N 个候选钉在原位（与 `HybridRanker.applyBm25Floor` 同一思想）。
 * **默认 0**：实测在本语料上地板近乎无操作（fileK=10 档 floor 0–5 结果逐字相同；
 * fileK=14 档 floor=0 的召回 41.0% 略高于 floor=5 的 40.8%），故不引入既无收益又需解释的常量。
 * 该选项保留给「第一段头部已被验证强于重排」的语料，由调用方显式指定。
 *
 * ## 实测（`evals/rerank-ab.mjs`，真实 `src/` 语料 470 文件 / 7606 符号，32 条真实锚点查询）
 *
 * | 口径                          | 第一段基线 | +重排  | Δ      | bootstrap 95% CI | 留出折（2-fold×20）        |
 * | ----------------------------- | ---------- | ------ | ------ | ---------------- | -------------------------- |
 * | 召回@14（本仓库检索范式口径） | 31.4%      | 41.0%  | +9.6pp | [1.80, 18.60] ✅ | 38/40 为正（min −0.78pp）✅ |
 * | 召回@10（生产入口默认预算）   | 26.9%      | 33.2%  | +6.3pp | [−0.45, 14.74] ❌ | 37/40 为正（min −0.89pp）❌ |
 *
 * 门槛（沿用 `docs/POLISH_PLAN.md` P1）：**CI 下界 > 0 且留出折为正**才算过。
 * 生产入口当前预算（fileK=10）**未过**，故 `enabled` 默认关（opt-in）；口径对齐的 fileK=14 档两关全过。
 *
 * 天花板对照：**完美重排**同一候选池（平均 37.6 个文件）在 @14 上只能取 54.7%，
 * 故本次拿到了约 44% 的可争取空间；池内 6/32 条查询的答案文件**在任何名次都不出现**
 * （查询与文件无任何词法交集），属**语义鸿沟**，词法重排**结构上够不到**，不作承诺。
 * 逐条代价诚实登记：@14 ↑9/↓3、@10 ↑3/↓1——回退均只丢 1 个 GT 文件，
 * 形态是「查询词为通用前缀（`tool` / `sandbox` / `server`）」时把同前缀兄弟文件一起抬起。
 *
 * ## 不做的事
 *
 *  - **不引模型**（零依赖铁律）：交叉编码器 reranker 曾在本仓试过并实测 **−1.0pp**（通用模型不懂代码），
 *    且与「零运行时依赖」冲突，已归档。
 *  - **不生成候选**（只重排入池文件），故不引入常量偏置；候选池的拓宽由第一段负责。
 *  - **不碰主循环**：本类是纯函数式打分器，由 `contextEngine.query` 在既有位置调用。
 *
 * @maturity L2 — 打分式经真实语料两关验证（否决器放行 + AB 召回对照），
 *   并以「候选池天花板」机械解释增益上限与不可达部分；但对照语料仅 1 个仓库 / 32 条查询，
 *   样本量不足以支撑 L3
 * @maturityEvidence tests/unit/fileReranker.test.ts
 */

import type { IndexedCorpus } from './contextEngine.js';
import { FileRerankIndex } from './fileRerankIndex.js';

/** 重排输入。 */
export interface FileRerankInput {
  /** 已索引语料。 */
  readonly corpus: IndexedCorpus;
  /** 查询原文。 */
  readonly query: string;
  /**
   * 第一段候选文件 rel 列表，**必须已按第一段得分降序**（下标 = 名次，1-based 即 `i + 1`）。
   */
  readonly candidates: readonly string[];
  /** 输出文件预算（Top-K）。 */
  readonly fileK: number;
  /**
   * 头部地板个数：把第一段前 N 个候选钉在原位。**缺省 0（不设地板）**——实测本语料上
   * 地板近乎无操作（见模块头「头部地板」节），故不引入需额外解释的常量；
   * 传 `fileK` 即完全不重排，供「第一段头部可信度高于重排」的语料使用。
   */
  readonly floor?: number;
}

/** 重排结果。 */
export interface FileRerankResult {
  /** 重排后的文件 rel 列表（已截断到 fileK）。 */
  readonly files: readonly string[];
  /** 实际生效的头部地板个数（诊断用，便于确认地板口径）。 */
  readonly pinned: number;
}

/**
 * 零依赖文件重排器：对第一段候选按「符号名 IDF 加权覆盖率」做第 2 段精排。
 *
 * 无状态（除注入的 {@link FileRerankIndex} 的按语料缓存），确定性，可安全复用于多查询。
 */
export class FileReranker {
  /** 语料级词法视图（惰性缓存协作者）。 */
  private readonly index: FileRerankIndex;

  /**
   * @param index 语料级词法视图；缺省自建一个（组合根可用同一实例跨查询共享缓存）
   */
  public constructor(index: FileRerankIndex = new FileRerankIndex()) {
    this.index = index;
  }

  /**
   * 执行第 2 段重排。
   * @param input 语料 + 查询 + 第一段候选（须已按第一段降序）+ 文件预算
   * @returns 重排后的文件列表与生效地板数
   */
  public rerank(input: FileRerankInput): FileRerankResult {
    const { corpus, query, candidates, fileK } = input;
    if (fileK <= 0 || candidates.length === 0) {
      return { files: [], pinned: 0 };
    }
    const terms = this.index.contentTerms(corpus, query);
    const scored = candidates.map((rel, i) => ({
      rel,
      rank: i + 1,
      score: 1 / (1 + (i + 1)) + this.coverageOf(corpus, rel, terms),
    }));
    // 稳定排序：同分按第一段名次，保证确定性（同输入恒同输出）。
    scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
    // 地板不得超过实际候选数（候选可能少于 fileK），否则「钉住数」会报出多于事实的值。
    const floor = Math.min(this.resolveFloor(input.floor, fileK), candidates.length);
    const ordered = scored.map((s) => s.rel);
    const files = floor > 0 ? this.applyFloor(ordered, candidates.slice(0, floor)) : ordered;
    return { files: files.slice(0, fileK), pinned: floor };
  }

  /**
   * 计算某文件的符号名 IDF 加权覆盖率。
   * @param corpus 已索引语料
   * @param rel 文件相对路径
   * @param terms 查询内容词
   * @returns 覆盖率 ∈ [0,1]；无内容词时为 0
   */
  private coverageOf(corpus: IndexedCorpus, rel: string, terms: readonly string[]): number {
    if (terms.length === 0) {
      return 0;
    }
    const names = this.index.nameTerms(corpus, rel);
    let total = 0;
    let covered = 0;
    for (const t of terms) {
      const w = this.index.weight(corpus, t);
      total += w;
      if (names.has(t)) {
        covered += w;
      }
    }
    return total > 0 ? covered / total : 0;
  }

  /**
   * 解析头部地板个数：显式值夹取到 `[0, fileK]`；缺省 0（不设地板，见模块头说明）。
   * @param requested 调用方显式指定值（可为 undefined）
   * @param fileK 文件预算
   * @returns 生效地板个数
   */
  private resolveFloor(requested: number | undefined, fileK: number): number {
    if (requested === undefined || !Number.isFinite(requested)) {
      return 0;
    }
    return Math.max(0, Math.min(Math.floor(requested), fileK));
  }

  /**
   * 把第一段头部钉在结果最前（保持其自身次序），其余按重排次序补齐。
   * @param ordered 重排后的完整文件次序
   * @param pinned 需钉住的头部文件（保持原次序）
   * @returns 新次序（未截断）
   */
  private applyFloor(ordered: readonly string[], pinned: readonly string[]): readonly string[] {
    const pinSet = new Set(pinned);
    return [...pinned, ...ordered.filter((rel) => !pinSet.has(rel))];
  }
}
