import type { MemoryFact } from './longTermMemory.js';
import type { Spectrum } from '../../util/eigenSpectrum.js';

/** 单条共振命中：事实 + 共振度。 */
export interface ResonantHit {
  readonly fact: MemoryFact;
  readonly score: number;
}

/**
 * 燧-3 共振寻址端口（Resonant Addressing）：检索不靠指针/向量相似度，
 * 而是发射频谱探针 p，记忆体中与其本征模共振的条目自行聚集显现，其余退场。
 * 寻址 = 共振而非匹配。BM25/ANN 等几何距离方法在代数上不支持此寻址维度。
 */
export interface ResonantMemoryPort {
  readonly name: string;
  /** 发射频谱探针，返回共振度最高的 k 条事实（同频即显、异频即散）。 */
  resonate(probe: Spectrum, k: number): readonly ResonantHit[];
  /** 便捷：把自然语言查询映射成探针谱后再共振寻址。 */
  resonateByText(query: string, k: number): readonly ResonantHit[];
  /** 调谐：重建频谱索引并返回 {facts, clusters}（ResonantMemoryEngine 与 ResonantFieldEngine 均实现）。 */
  tune(): { readonly facts: number; readonly clusters: number };
}
