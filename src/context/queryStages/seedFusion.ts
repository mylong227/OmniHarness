/**
 * 种子融合阶段（C7 拆分，2026-10-02）：BM25 ∪ 频域共振 ∪ LSA → 扩散重启向量。
 *
 * 从 `ContextEngine.query` 原样迁出（逻辑逐字等价，仅结构化入参/出参）。
 * 三路信号各自归一化加权：BM25 0.6 / 共振 0.4 / LSA 0.5（同符号取 max）。
 */
import { EigenSpectrum, RESONANCE_BINS, type Spectrum } from '../../util/eigenspectrum.js';
import { LsaEngine, type LsaModel } from '../lsaEngine.js';
import type { ScoredId } from './candidateSearch.js';

/** 种子阶段所需的语料切片（结构化子集）。 */
export interface SeedCorpusView {
  /** 每个符号的本征频谱（燧-3 频域召回），与 symbols 按索引一一对应。 */
  readonly symbolSpectra: readonly Spectrum[];
  /** 潜语义（LSA）模型：把词与符号投影到潜空间（桥接词法错位）。 */
  readonly lsaModel: LsaModel;
}

/** 种子阶段选项。 */
export interface SeedFusionOptions {
  /** 是否启用 LSA 召回（实测默认无增益，仅供评测开启）。 */
  readonly lsa: boolean;
  /** 符号候选预算（共振路取 SYM_K×2）。 */
  readonly symK: number;
}

/** 种子阶段产物。 */
export interface SeedFusionResult {
  /** 三路并集的符号 id 集（图扩散/层化图会继续往里补充）。 */
  readonly symIdSet: Set<number>;
  /** 归一化加权后的种子分数（PageRank 重启向量）。 */
  readonly seed: Map<number, number>;
}

/**
 * 种子融合阶段：三路符号信号并集 + 加权成种子。
 */
export class SeedFusion {
  /**
   * 融合 BM25 / 频域共振 / LSA 三路符号信号。
   *
   * @param corpus 语料切片。
   * @param q 原始查询（共振探针与 LSA 投影的输入）。
   * @param options 选项（lsa 开关 + symK 预算）。
   * @param bm25SymHits 符号路 BM25 命中（搜索阶段产物）。
   * @returns 符号并集与种子分数。
   */
  public static fuse(
    corpus: SeedCorpusView,
    q: string,
    options: SeedFusionOptions,
    bm25SymHits: readonly ScoredId[],
  ): SeedFusionResult {
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
    const resSymIds = new Set(resHits.slice(0, options.symK * 2).map((h) => h.id));

    // 潜语义（LSA）召回：把查询投影到潜空间，召回「概念相关」符号（桥接词法错位）。
    const lsaHits: Array<{ id: number; score: number }> = [];
    let lsaMax = 0;
    if (options.lsa && corpus.lsaModel) {
      for (const h of LsaEngine.lsaQuery(corpus.lsaModel, q, 60)) {
        lsaHits.push({ id: h.id, score: h.score });
        lsaMax = Math.max(lsaMax, Math.abs(h.score));
      }
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
    return { symIdSet, seed };
  }
}
