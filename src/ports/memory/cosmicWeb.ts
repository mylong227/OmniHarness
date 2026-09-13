import type { MemoryFact } from './longTermMemory.js';
import type { Spectrum } from '../../util/eigenspectrum.js';

/** 宇宙网一次 RG 粗粒化坍缩的报告。 */
export interface WebConsolidationReport {
  /** 坍缩后节点数（受 Bekenstein 容量界约束）。 */
  readonly nodes: number;
  /** 本轮坍缩掉的节点数（合并进更大簇）。 */
  readonly collapsed: number;
  /** 纤维数（节点间共振边，宇宙网骨架）。 */
  readonly fibers: number;
}

/**
 * 宇宙网记忆端口（Cosmic-Web Memory，I-P1-2）。S+ 发明层。
 *
 * 长期记忆不是"条目堆"，而是一张持续自组织的宇宙网：
 * - 巩固 = Burgers 黏附（不可逆写入只在收敛点发生）——新事实若与某节点共振≥黏附半径，
 *   则被黏附进该节点（去重强化），不新建条目；
 * - 检索 = 沿纤维到达节点（fiber）；
 * - 容量超限 → RG 粗粒化坍缩（自动抽象坍缩而非膨胀）。
 * 几何/向量范式在代数上不支持此自组织（市面唯一）。
 */
export interface CosmicWebPort {
  readonly name: string;
  /** 写入一条事实：黏附去重或新建节点。 */
  remember(fact: MemoryFact): void;
  /** RG 粗粒化坍缩：节点数超 Bekenstein 容量界时合并最小簇为抽象代表（不膨胀）。 */
  consolidate(): WebConsolidationReport;
  /** 沿纤维到达节点：发射频谱探针，返回共振簇成员（纤维）。 */
  fiber(probe: Spectrum, k: number): readonly MemoryFact[];
}
