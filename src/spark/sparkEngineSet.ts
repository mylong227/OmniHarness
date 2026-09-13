import type { ResonantMemoryPort } from '../ports/memory/resonantMemory.js';
import type { VortexRingSpillAdapter } from '../adapters/spill/vortexRingSpillAdapter.js';
import type { MemoryAnnealer } from '../ports/memory/memoryAnnealing.js';
import type { CosmicWebPort } from '../ports/memory/cosmicWeb.js';
import type { QECEncoder } from '../adapters/memory/qecEncoder.js';
import type { ImmuneMonitorPort } from '../ports/intelligence/immune.js';
import type { NaturalGradientBelief } from '../adapters/belief/naturalGradientBelief.js';
import type { ParticleFilterBelief } from '../adapters/belief/particleFilterBelief.js';
import type { CRISPRSkillEditor } from '../adapters/skill/crisprSkillEditor.js';
import type { CapabilityCrystallizer } from '../adapters/skill/capabilityCrystallizer.js';
import type { InsightEtchingEngine } from '../adapters/memory/insightEtchingEngine.js';
import type { ElementComposer } from '../adapters/skill/elementComposer.js';
import type { SymmetryBreakingEngine } from '../adapters/monitoring/symmetryBreakingEngine.js';
import type { ConfinementEngine } from '../adapters/monitoring/confinementEngine.js';
import type { CapabilityCharge } from '../ports/runtime/confinement.js';
import type { SparkEngines } from '../genesis/operators.js';
import type { SparkControllerOptions } from './sparkController.js';

/**
 * 燧内核「一组可选引擎」的聚合值对象。
 *
 * 把 `SparkControllerOptions` 里散落的 20 个可选引擎/探针归拢为一个内聚单元，
 * 使 `SparkController` 只持有一个字段而非二十余个，消除「上帝类」式的字段爆炸。
 * 同时提供 `toGenesisEngines()` 供 Genesis 编排桥复用同一批实例（零重复装配）。
 */
export class SparkEngineSet {
  /** 燧-3 共振寻址引擎。 */
  public readonly resonance?: ResonantMemoryPort | undefined;
  /** 燧-4 涡环包外溢适配器。 */
  public readonly vortex?: VortexRingSpillAdapter | undefined;
  /** (D) 热方程记忆退火器。 */
  public readonly annealer?: MemoryAnnealer | undefined;
  /** (E) 宇宙网记忆引擎。 */
  public readonly web?: CosmicWebPort | undefined;
  /** (E) QEC 记忆编码器。 */
  public readonly qec?: QECEncoder | undefined;
  /** (E) 免疫异常监控器。 */
  public readonly immune?: ImmuneMonitorPort | undefined;
  /** 免疫采样器：每轮自检观测的自体行为向量。 */
  public readonly immuneSample?: (() => readonly number[]) | undefined;
  /** (P2) 自然梯度信念引擎。 */
  public readonly naturalGradient?: NaturalGradientBelief | undefined;
  /** (P2) 粒子滤波信念引擎。 */
  public readonly particleFilter?: ParticleFilterBelief | undefined;
  /** (P2) 信念采样器。 */
  public readonly beliefObservation?: (() => readonly number[]) | undefined;
  /** (P2) CRISPR 精确技能编辑器。 */
  public readonly crispr?: CRISPRSkillEditor | undefined;
  /** (P2) 相变固化器。 */
  public readonly crystallizer?: CapabilityCrystallizer | undefined;
  /** (P3) 刻蚀记忆引擎。 */
  public readonly etching?: InsightEtchingEngine | undefined;
  /** (P3) 刻蚀导通探针。 */
  public readonly etchProbe?: (() => string) | undefined;
  /** (P3) 元素组合基元引擎。 */
  public readonly elementComposer?: ElementComposer | undefined;
  /** (P3) 组合探针。 */
  public readonly composeProbe?: (() => readonly string[]) | undefined;
  /** (P3) 对称破缺引擎。 */
  public readonly symmetry?: SymmetryBreakingEngine | undefined;
  /** (P3) 对称观测探针。 */
  public readonly symmetryProbe?:
    (() => readonly { capability: string; weight: number }[]) | undefined;
  /** (P3) 禁闭色荷引擎。 */
  public readonly confinement?: ConfinementEngine | undefined;
  /** (P3) 暴露探针。 */
  public readonly confinementProbe?: (() => CapabilityCharge) | undefined;

  /**
   * @param opts 燧控制器选项（仅读取其引擎字段）
   */
  public constructor(opts: SparkControllerOptions) {
    this.resonance = opts.resonance;
    this.vortex = opts.vortex;
    this.annealer = opts.annealer;
    this.web = opts.web;
    this.qec = opts.qec;
    this.immune = opts.immune;
    this.immuneSample = opts.immuneSample;
    this.naturalGradient = opts.naturalGradient;
    this.particleFilter = opts.particleFilter;
    this.beliefObservation = opts.beliefObservation;
    this.crispr = opts.crispr;
    this.crystallizer = opts.crystallizer;
    this.etching = opts.etching;
    this.etchProbe = opts.etchProbe;
    this.elementComposer = opts.elementComposer;
    this.composeProbe = opts.composeProbe;
    this.symmetry = opts.symmetry;
    this.symmetryProbe = opts.symmetryProbe;
    this.confinement = opts.confinement;
    this.confinementProbe = opts.confinementProbe;
  }

  /**
   * 镜像为 Genesis 编排所需的 `SparkEngines`（同一批实例，零重复装配）。
   *
   * @returns 供 `GenesisSparkBridge` 消费的引擎集合
   */
  public toGenesisEngines(): SparkEngines {
    return {
      resonance: this.resonance,
      vortex: this.vortex,
      annealer: this.annealer,
      web: this.web,
      qec: this.qec,
      immune: this.immune,
      immuneSample: this.immuneSample,
      naturalGradient: this.naturalGradient,
      particleFilter: this.particleFilter,
      beliefObservation: this.beliefObservation,
      crispr: this.crispr,
      crystallizer: this.crystallizer,
      etching: this.etching,
      etchProbe: this.etchProbe,
      elementComposer: this.elementComposer,
      composeProbe: this.composeProbe,
      symmetry: this.symmetry,
      symmetryProbe: this.symmetryProbe,
      confinement: this.confinement,
      confinementProbe: this.confinementProbe,
    };
  }
}
