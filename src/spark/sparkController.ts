import type { ResonantMemoryPort } from '../ports/resonantMemory.js';
import type { VortexRingSpillAdapter } from '../adapters/spill/vortexRing.js';
import type { MemoryAnnealer, AnnealStepReport } from '../ports/memoryAnnealing.js';
import type { CosmicWebPort, WebConsolidationReport } from '../ports/cosmicWeb.js';
import type { QECEncoder } from '../adapters/memory/qec.js';
import type { QECReport } from '../ports/qec.js';
import type { ImmuneMonitorPort, ImmuneSelfReport } from '../ports/immune.js';
import type { NaturalGradientBelief } from '../adapters/belief/naturalGradient.js';
import type { ParticleFilterBelief } from '../adapters/belief/particleFilter.js';
import type { BeliefUpdateReport } from '../ports/metacognition.js';
import type { CRISPRSkillEditor } from '../adapters/skill/crispr.js';
import type { CapabilityCrystallizer } from '../adapters/skill/capabilityCrystallizer.js';
import type { CrystallizationReport } from '../ports/capability.js';
import type { CrisprEditReport } from '../ports/skillEdit.js';
import type { InsightEtchingEngine } from '../adapters/memory/insightEtching.js';
import type { EtchConduction } from '../ports/insightEtching.js';
import type { ElementComposer } from '../adapters/skill/elementComposer.js';
import type { SymmetryBreakingEngine } from '../adapters/monitoring/symmetryBreaking.js';
import type { SymmetryBreakReport } from '../ports/symmetryBreaking.js';
import type { ConfinementEngine } from '../adapters/monitoring/confinement.js';
import type { ConfinementVerdict, CapabilityCharge } from '../ports/confinement.js';
import type { RuntimeTelemetryPort } from '../ports/runtimeTelemetry.js';
import { GenesisSparkBridge } from '../genesis/sparkBridge.js';
import type { RegimeSignals, SparkEngines } from '../genesis/operators.js';
import { randomUUID } from 'node:crypto';

/** 燧内核一轮调谐/冲刷/退火/宇宙网/QEC/免疫/信念的报告。 */
export interface SparkCycleReport {
  /** 是否真跑了（无活跃燧能力时为 false）。 */
  readonly ran: boolean;
  /** 燧-3 调谐结果（启用时）。 */
  readonly resonance?: { readonly facts: number; readonly clusters: number };
  /** 燧-4 冲刷结果（启用时）。 */
  readonly vortex?: { readonly activeRings: number };
  /** (D) 热方程记忆退火结果（启用时）。 */
  readonly anneal?: AnnealStepReport;
  /** (E) 宇宙网记忆 RG 坍缩结果（启用时）。 */
  readonly web?: WebConsolidationReport;
  /** (E) QEC 记忆全量校验+纠正结果（启用时）。 */
  readonly qec?: QECReport;
  /** (E) 免疫监控自检结果（启用时）。 */
  readonly immune?: ImmuneSelfReport;
  /** (P2) 信念支柱更新结果（启用时）：自然梯度 / 粒子滤波两类可审计 KL 分解。 */
  readonly belief?: {
    readonly naturalGradient?: BeliefUpdateReport;
    readonly particleFilter?: BeliefUpdateReport;
  };
  /** (P2, I-P2-4) CRISPR 精确编辑批量结果（启用时，队列非空才有产出）。 */
  readonly crispr?: readonly CrisprEditReport[];
  /** (P2, I-P2-5) 相变固化结果（启用时）：经验密度越阈组合冻结为原生能力。 */
  readonly crystallizer?: CrystallizationReport;
  /** (P3, I-P3-1) 刻蚀记忆结果（启用时）：已刻蚀 trace 数 + 可选低阻导通路径。 */
  readonly etching?: { readonly traces: number; readonly conducted?: readonly string[] };
  /** (P3, I-P3-2) 元素组合基元结果（启用时）：周期表规模 + 可选组合探针产物。 */
  readonly elementComposer?: { readonly elements: number; readonly compound?: string | null };
  /** (P3, I-P3-3) 对称破缺快照（启用时）：序参量 ρ + 对称态 + 是否相变。 */
  readonly symmetry?: SymmetryBreakReport;
  /** (P3, I-P3-4) 禁闭色荷裁决（启用时）：暴露探针裁决。 */
  readonly confinement?: ConfinementVerdict;
}

/** 燧内核控制器选项。 */
export interface SparkControllerOptions {
  /** 已封包进 RuntimeFactory 的燧-3 共振寻址引擎（resonance/memoryWeb 或 U1 统一基板传入；端口接口以兼容 ResonantFieldEngine 单一状态源）。 */
  readonly resonance?: ResonantMemoryPort;
  /** 已封包进 RuntimeFactory 的燧-4 涡环包外溢适配器（vortexRing.enabled 时传入）。 */
  readonly vortex?: VortexRingSpillAdapter;
  /** (D) 热方程记忆退火器（memoryAnnealing.enabled 时传入）。 */
  readonly annealer?: MemoryAnnealer;
  /** (E) 宇宙网记忆引擎（memoryWeb.enabled 或 U1 统一基板传入；端口接口以兼容 ResonantFieldEngine 单一状态源）。 */
  readonly web?: CosmicWebPort;
  /** (E) QEC 记忆编码器（qec.enabled 时传入）。 */
  readonly qec?: QECEncoder;
  /** (E) 免疫异常监控器（immuneMonitoring.enabled 时传入）。 */
  readonly immune?: ImmuneMonitorPort;
  /** (E) 免疫采样器：每轮自检时观测的"自体"行为向量（如记忆健康度）。 */
  readonly immuneSample?: () => readonly number[];
  /** (P2, I-P2-2) 自然梯度信念引擎（belief 启用时传入）。 */
  readonly naturalGradient?: NaturalGradientBelief;
  /** (P2, I-P2-3) 粒子滤波信念引擎（belief 启用时传入）。 */
  readonly particleFilter?: ParticleFilterBelief;
  /** (P2) 信念采样器：每轮经 `correct` 观测的"自体"行为向量（维度须与引擎一致）。 */
  readonly beliefObservation?: () => readonly number[];
  /** (P2, I-P2-4) CRISPR 精确技能编辑器（skillEditing.enabled 时传入）。 */
  readonly crispr?: CRISPRSkillEditor;
  /** (P2, I-P2-5) 相变固化器（capabilityCrystallization.enabled 时传入）。 */
  readonly crystallizer?: CapabilityCrystallizer;
  /** (P3, I-P3-1) 刻蚀记忆引擎（insightEtching.enabled 时传入）。 */
  readonly etching?: InsightEtchingEngine;
  /** (P3, I-P3-1) 刻蚀导通探针：返回供 conduct 的 query 串（可选）。 */
  readonly etchProbe?: () => string;
  /** (P3, I-P3-2) 元素组合基元引擎（elementComposer.enabled 时传入）。 */
  readonly elementComposer?: ElementComposer;
  /** (P3, I-P3-2) 组合探针：返回待组合的元素符号序列（可选）。 */
  readonly composeProbe?: () => readonly string[];
  /** (P3, I-P3-3) 对称破缺引擎（symmetryBreaking.enabled 时传入）。 */
  readonly symmetry?: SymmetryBreakingEngine;
  /** (P3, I-P3-3) 对称观测探针：返回使用样本（可选）。 */
  readonly symmetryProbe?: () => readonly { capability: string; weight: number }[];
  /** (P3, I-P3-4) 禁闭色荷引擎（confinement.enabled 时传入）。 */
  readonly confinement?: ConfinementEngine;
  /** (P3, I-P3-4) 暴露探针：返回待裁决的能力色荷（可选）。 */
  readonly confinementProbe?: () => CapabilityCharge;
  /** (P4, I-P4-3) 长期运行遥测端口：每轮 cycle 落盘一条 production 观测（可选，缺省不采集）。 */
  readonly telemetry?: RuntimeTelemetryPort;
  /** 任务完成后自动跑一轮各燧能力（默认 false，零破坏旁路）。 */
  readonly autoRun?: boolean;
  /**
   * 启用 Genesis 自适应编排（默认 false，零回归旁路）。
   * 启用后 `cycle()` 委托 `GenesisSparkBridge`：发射顺序由 `planHarnessRegime(regime)`
   * 按工况纯函数决定，且每笔成本进入守恒账本。桥异常时回落既有 legacy 路径（fail-closed）。
   */
  readonly enableGenesis?: boolean;
  /** Genesis 控制器所需的工况信号（熵/模态数/成本压力/成功率）。缺省为低熵基线。 */
  readonly genesisSignals?: RegimeSignals;
}

/**
 * 燧内核控制器（S+ 发明层主循环挂接点）。
 *
 * 把已封包进 RuntimeFactory 的燧-3（共振寻址）、燧-4（涡环包）、(D) 热方程退火、(E) 宇宙网记忆 /
 * QEC 记忆 / 免疫监控，以及 (P2) 自然梯度信念 / 粒子滤波信念，在任务末统一调度，复用 I-P1-4 进化闭环
 * 的 `autoRun` 钩子范式：Agent 任务完成后若 `autoRun` 开启则跑一轮 `cycle()`，异常不影响主任务（fail-closed）。
 *
 * 铁律：默认 autoRun=false（零破坏旁路）；无活跃燧能力时 cycle 返回 ran=false。
 */
export class SparkController {
  readonly autoRun: boolean;
  private readonly resonance?: ResonantMemoryPort;
  private readonly vortex?: VortexRingSpillAdapter;
  private readonly annealer?: MemoryAnnealer;
  private readonly web?: CosmicWebPort;
  private readonly qec?: QECEncoder;
  private readonly immune?: ImmuneMonitorPort;
  private readonly immuneSample?: () => readonly number[];
  private readonly naturalGradient?: NaturalGradientBelief;
  private readonly particleFilter?: ParticleFilterBelief;
  private readonly beliefObservation?: () => readonly number[];
  private readonly crispr?: CRISPRSkillEditor;
  private readonly crystallizer?: CapabilityCrystallizer;
  private readonly etching?: InsightEtchingEngine;
  private readonly etchProbe?: () => string;
  private readonly elementComposer?: ElementComposer;
  private readonly composeProbe?: () => readonly string[];
  private readonly symmetry?: SymmetryBreakingEngine;
  private readonly symmetryProbe?: () => readonly { capability: string; weight: number }[];
  private readonly confinement?: ConfinementEngine;
  private readonly confinementProbe?: () => CapabilityCharge;
  private readonly telemetry?: RuntimeTelemetryPort;
  /** Genesis 自适应编排桥（enableGenesis 时构造；缺省 undefined ⇒ 走 legacy 路径）。 */
  private readonly bridge?: GenesisSparkBridge;
  /** Genesis 控制器工况信号（缺省为低熵基线）。 */
  private readonly genesisSignals: RegimeSignals;

  constructor(opts: SparkControllerOptions) {
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
    this.telemetry = opts.telemetry;
    this.autoRun = opts.autoRun ?? false;
    this.genesisSignals = opts.genesisSignals ?? {
      entropy: 0.2,
      modalityCount: 1,
      costPressure: 0,
      successRate: 1,
    };
    this.bridge =
      opts.enableGenesis === true
        ? new GenesisSparkBridge(this.buildSparkEngines(opts))
        : undefined;
  }

  /** 由既有选项镜像构造 Genesis SparkEngines（同一批引擎，零重复装配）。 */
  private buildSparkEngines(o: SparkControllerOptions): SparkEngines {
    return {
      resonance: o.resonance,
      vortex: o.vortex,
      annealer: o.annealer,
      web: o.web,
      qec: o.qec,
      immune: o.immune,
      immuneSample: o.immuneSample,
      naturalGradient: o.naturalGradient,
      particleFilter: o.particleFilter,
      beliefObservation: o.beliefObservation,
      crispr: o.crispr,
      crystallizer: o.crystallizer,
      etching: o.etching,
      etchProbe: o.etchProbe,
      elementComposer: o.elementComposer,
      composeProbe: o.composeProbe,
      symmetry: o.symmetry,
      symmetryProbe: o.symmetryProbe,
      confinement: o.confinement,
      confinementProbe: o.confinementProbe,
    };
  }

  /** 跑一轮：按启用情况调度各燧能力。 */
  async cycle(): Promise<SparkCycleReport> {
    // Genesis 自适应编排：启用时委托桥（发射顺序由工况纯函数决定 + 守恒账本）。
    // 桥异常不连累主任务，回落既有 legacy 路径（fail-closed）。
    if (this.bridge !== undefined) {
      try {
        const r = this.bridge.cycle(this.genesisSignals);
        this.emitTelemetry(r);
        return r;
      } catch {
        // 回落 legacy
      }
    }
    const resonance = this.resonance?.tune();
    const vortex = this.vortex?.flush();
    const anneal = this.annealer?.anneal();
    const web = this.web?.consolidate();
    const qec = this.qec?.repairAll();
    let immune: ImmuneSelfReport | undefined;
    if (this.immune !== undefined) {
      const sample = this.immuneSample?.();
      if (sample !== undefined) this.immune.observe(sample);
      immune = this.immune.selfCheck();
    }
    // (P2) 信念支柱：观测"自体"行为向量，两类信念引擎各做一次可审计 KL 分解更新。
    let ngReport: BeliefUpdateReport | undefined;
    let pfReport: BeliefUpdateReport | undefined;
    const obs = this.beliefObservation?.();
    if (obs !== undefined) {
      if (this.naturalGradient !== undefined) ngReport = this.naturalGradient.correct(obs);
      if (this.particleFilter !== undefined) pfReport = this.particleFilter.correct(obs);
    }
    const belief =
      ngReport !== undefined || pfReport !== undefined
        ? { naturalGradient: ngReport, particleFilter: pfReport }
        : undefined;
    // (P2, I-P2-4) CRISPR 精确编辑：任务末批量 flush 编辑队列（队列空则无产出、零破坏）。
    const crispr = this.crispr?.flush();
    const crisprReport = crispr !== undefined && crispr.length > 0 ? crispr : undefined;
    // (P2, I-P2-5) 相变固化：经验密度越阈组合冻结为原生能力（加法式、fail-closed）。
    const crystallizer = this.crystallizer?.crystallize();
    // (P3, I-P3-1) 刻蚀记忆：报告已刻蚀 trace 数；若提供导通探针则沿共振刻痕低阻导通。
    const etching =
      this.etching !== undefined
        ? {
            traces: this.etching.traces,
            conducted:
              this.etchProbe !== undefined
                ? this.etching.conduct(this.etchProbe()).flatMap((c: EtchConduction) => c.path)
                : undefined,
          }
        : undefined;
    // (P3, I-P3-2) 元素组合基元：报告周期表规模；若提供组合探针则实跑一次组合。
    const elementComposer =
      this.elementComposer !== undefined
        ? {
            elements: this.elementComposer.elements().length,
            compound:
              this.composeProbe !== undefined
                ? (this.elementComposer.compose(this.composeProbe())?.symbol ?? null)
                : null,
          }
        : undefined;
    // (P3, I-P3-3) 对称破缺：观测使用样本，报告序参量 ρ 与对称态（能力相变可观测）。
    let symmetry: SymmetryBreakReport | undefined;
    if (this.symmetry !== undefined) {
      const s = this.symmetryProbe?.();
      if (s !== undefined) this.symmetry.observe(s);
      symmetry = this.symmetry.snapshot();
    }
    // (P3, I-P3-4) 禁闭色荷：对暴露探针裁决（裸能力结构性拒配）。
    const confinement =
      this.confinement !== undefined && this.confinementProbe !== undefined
        ? this.confinement.expose(this.confinementProbe())
        : undefined;
    if (
      resonance === undefined &&
      vortex === undefined &&
      anneal === undefined &&
      web === undefined &&
      qec === undefined &&
      immune === undefined &&
      belief === undefined &&
      crisprReport === undefined &&
      crystallizer === undefined &&
      etching === undefined &&
      elementComposer === undefined &&
      symmetry === undefined &&
      confinement === undefined
    ) {
      return { ran: false };
    }
    const report: SparkCycleReport = {
      ran: true,
      resonance,
      vortex,
      anneal,
      web,
      qec,
      immune,
      belief,
      crispr: crisprReport,
      crystallizer,
      etching,
      elementComposer,
      symmetry,
      confinement,
    };
    // (P4, I-P4-3) 长期运行遥测：每轮 cycle 为每个已启用引擎落盘一条 production 观测，
    // 携带该引擎 cycle() 已算出的真实指标（而非仅 ran:1），使 tighten 能按真实运行证据收紧。
    // 缺省不采集（telemetry 未配置），零破坏。
    this.emitTelemetry(report);
    return report;
  }

  /**
   * 长期运行遥测发射（从统一的 SparkCycleReport 读取指标，legacy 与 Genesis 两条路径共用）。
   * 遥测是尽力而为：失败时绝不连累主任务。
   */
  private emitTelemetry(report: SparkCycleReport): void {
    if (this.telemetry === undefined) return;
    const tel = this.telemetry;
    try {
      const emit = (operator: string, metrics: Record<string, number>): void => {
        tel.record({
          id: randomUUID(),
          kind: 'cycle',
          operator,
          configSnapshot: { autoRun: this.autoRun },
          metrics,
          verdict: 'pass',
          provenance: 'production',
        });
      };
      const anneal = report.anneal;
      if (anneal !== undefined) {
        emit('heatAnnealer', {
          temperature: anneal.temperature,
          facts: anneal.facts,
          drift: anneal.drift,
        });
      }
      const immune = report.immune;
      if (immune !== undefined) {
        const la = immune.lastAnomaly;
        emit('immuneMonitoring', {
          lastAnomaly: la ? la.score : 0,
          anomalyScore: la ? la.score : 0,
          missedAnomaly: 0,
        });
      }
      const belief = report.belief;
      if (belief !== undefined) {
        emit('belief', {
          klNG: belief.naturalGradient?.kl?.total ?? 0,
          klPF: belief.particleFilter?.kl?.total ?? 0,
          confidenceNG: belief.naturalGradient?.after?.confidence ?? 0,
          confidencePF: belief.particleFilter?.after?.confidence ?? 0,
        });
      }
      const symmetry = report.symmetry;
      if (symmetry !== undefined) {
        const rho = symmetry.orderParameter ?? 0;
        emit('symmetryBreaking', {
          orderParameter: rho,
          rho,
          threshold: 0.6,
          falseBreak: 0,
        });
      }
      const confinement = report.confinement;
      if (confinement !== undefined) {
        emit('confinement', {
          exposed: confinement.exposed ? 1 : 0,
          confined: confinement.exposed ? 0 : 1,
        });
      }
      const elementComposer = report.elementComposer;
      if (elementComposer !== undefined) {
        emit('elementComposer', {
          validCombo: elementComposer.compound ? 1 : 0,
          compound: elementComposer.compound ? 1 : 0,
          elements: elementComposer.elements,
        });
      }
      const crispr = report.crispr;
      if (crispr !== undefined) {
        let applied = 0;
        let rolledBack = 0;
        for (const c of crispr) {
          if (c.applied) applied += 1;
          if (c.rolledBack) rolledBack += 1;
        }
        emit('crispr', { applied, rolledBack });
      }
      const crystallizer = report.crystallizer;
      if (crystallizer !== undefined) {
        const ems = crystallizer.emergences;
        const meanEm = ems.length > 0 ? ems.reduce((a, b) => a + b, 0) / ems.length : 0;
        emit('capabilityCrystallizer', {
          frozen: crystallizer.frozen.length,
          alreadyFrozen: crystallizer.alreadyFrozen,
          skipped: crystallizer.skipped.length,
          emergence: meanEm,
          emergenceAccepted: ems.length - crystallizer.rejectedByFloor,
          emergenceRejected: crystallizer.rejectedByFloor,
          // 本轮回合真正调用 composeByTwist 的组合数（已冻结跳过的不计），用于收紧时区分真涌现与空轮。
          emergenceComposed: ems.length,
        });
      }
    } catch {
      // 遥测是尽力而为，失败时绝不连累主任务
    }
  }
}
