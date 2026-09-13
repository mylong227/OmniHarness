/**
 * 共振场统一端口（U1 — 把 燧-3 共振寻址 与 宇宙网 合并为单一共振场）。
 *
 * 此前 `ResonantMemoryEngine` 与 `CosmicWebMemoryEngine` 各自维护一份本征频谱索引
 * （同一条事实的频谱被重复计算/存储两次），且二者嵌套装饰同一 base。本端口把两种能力
 * 收敛为单一「场」：共振寻址（resonate）、纤维召回（fiber）、RG 坍缩（consolidate）、
 * 调谐（tune）三合一，消除重复状态源。
 *
 * @beta 属 S+ 发明层统一基板，接口仍可能微调。
 */
import type { LongTermMemoryPort, MemoryFact } from './longTermMemory.js';
import type { ResonantHit } from './resonantMemory.js';
import type { WebConsolidationReport } from './cosmicWeb.js';
import type { Spectrum } from '../../util/eigenSpectrum.js';

/**
 * 共振场端口：场查询 + 坍缩 + 调谐 的统一接口。
 */
export interface ResonantFieldPort {
  /** 端口名。 */
  readonly name: string;
  /** 频率域探针 → 共振度 top-k 事实（取代 BM25 几何召回）。 */
  resonate(probe: Spectrum, k: number): readonly ResonantHit[];
  /** 文本 → 探针 → 共振 top-k 事实。 */
  resonateByText(query: string, k: number): readonly ResonantHit[];
  /** 沿共振纤维（簇）召回：返回最共振簇的成员事实。 */
  fiber(probe: Spectrum, k: number): readonly MemoryFact[];
  /** RG 粗粒化坍缩（Bekenstein 容量界约束）。 */
  consolidate(): WebConsolidationReport;
  /** 调谐：重建全部谱/簇，返回事实数与簇数（守恒自检）。 */
  tune(): { readonly facts: number; readonly clusters: number };
}

/** 共振场引擎选项（合并原 resonance + memoryWeb 配置）。 */
export interface ResonantFieldOptions {
  /** 黏附半径（共振度阈值）：新事实与簇共振≥此值则黏附去重。默认 0.75。 */
  readonly adhesionThreshold?: number;
  /** Bekenstein 容量界：簇数硬上限，超限触发 RG 坍缩。默认 64。 */
  readonly bekensteinCap?: number;
  /** 纤维边阈值。默认 0.4。 */
  readonly edgeThreshold?: number;
  /** 本征谱分箱（须与记忆引擎一致）。默认 257。 */
  readonly bins?: number;
  /** 时间衰减半衰期（天）：recall 分数 = 相关性 × 0.5^(年龄/半衰期)。默认 90。 */
  readonly halfLifeDays?: number;
  /** 时钟（注入用，便于测试）；返回当前毫秒时间戳。默认 Date.now。 */
  readonly clock?: () => number;
}
