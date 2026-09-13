/**
 * 仿生算子提升层（Operator lift）——把既有九个仿生引擎统一接入 Genesis 代数。
 *
 * 这不是功能堆砌，而是把"一次系统变换"统一为 `HarnessOperator`：
 *   `HarnessOperator = (state, engines) => { next, cost, report, events }`
 * 每个算子**真实调用对应引擎方法**（镜像 SparkController.cycle 的既有调用），
 * 因此它是既有能力的 lawful morphism（合法态射），而非另写一套逻辑。
 *
 * 统一后，自适应元控制器 `planHarnessRegime` 可纯函数地按工况重排算子管线，
 * 使"架构适应力强"成为运行时真实行为（见 sparkBridge.ts）。
 */

import { type Cost, emptyCost, cost } from './algebra.js';
import { type Regime } from './regime.js';
import { type ModalityKind } from './modalityPort.js';

import type { ResonantMemoryPort } from '../ports/memory/resonantMemory.js';
import type { VortexRingSpillAdapter } from '../adapters/spill/vortexRingSpillAdapter.js';
import type { MemoryAnnealer, AnnealStepReport } from '../ports/memory/memoryAnnealing.js';
import type { CosmicWebPort } from '../ports/memory/cosmicWeb.js';
import type { WebConsolidationReport } from '../ports/memory/cosmicWeb.js';
import type { QECEncoder } from '../adapters/memory/qecEncoder.js';
import type { QECReport } from '../ports/intelligence/qec.js';
import type { ImmuneMonitorPort, ImmuneSelfReport } from '../ports/intelligence/immune.js';
import type { NaturalGradientBelief } from '../adapters/belief/naturalGradientBelief.js';
import type { ParticleFilterBelief } from '../adapters/belief/particleFilterBelief.js';
import type { BeliefUpdateReport } from '../ports/intelligence/metacognition.js';
import type { CRISPRSkillEditor } from '../adapters/skill/crisprSkillEditor.js';
import type { CrisprEditReport } from '../ports/runtime/skillEdit.js';
import type { CapabilityCrystallizer } from '../adapters/skill/capabilityCrystallizer.js';
import type { CrystallizationReport } from '../ports/intelligence/capability.js';
import type { InsightEtchingEngine } from '../adapters/memory/insightEtchingEngine.js';
import type { EtchConduction } from '../ports/memory/insightEtching.js';
import type { ElementComposer } from '../adapters/skill/elementComposer.js';
import type { SymmetryBreakingEngine } from '../adapters/monitoring/symmetryBreakingEngine.js';
import type { SymmetryBreakReport } from '../ports/intelligence/symmetryBreaking.js';
import type { ConfinementEngine } from '../adapters/monitoring/confinementEngine.js';
import type { ConfinementVerdict, CapabilityCharge } from '../ports/runtime/confinement.js';

/** 统一 Harness 状态（算子在其上做纯变换；成本另由 Ledger 计量）。 */
export interface HarnessState {
  /** 退火温度（heatAnnealer 输出）。 */
  readonly temperature: number;
  /** 序参量 ρ（symmetryBreaking 输出）。 */
  readonly orderParameter: number;
  /** 是否暴露裸能力（confinement 裁决）。 */
  readonly exposed: boolean;
  /** 当前派生熵（report/对齐用）。 */
  readonly entropy: number;
  /** 模态数（自适应用）。 */
  readonly modalityCount: number;
  /** 累计 token 成本（估算代理）。 */
  readonly costAccumTokens: number;
  /** 任务成功率（自适应用）。 */
  readonly successRate: number;
}

/** 工况信号（由运行时提取，交给 deriveRegime 映射为代数 Regime）。 */
export interface RegimeSignals {
  readonly entropy: number;
  readonly modalityCount: number;
  /** 成本压力 ∈ [0,1]（spent/budget）。 */
  readonly costPressure: number;
  readonly successRate: number;
}

/** 算子所需的真实引擎集合（镜像 SparkControllerOptions 的引擎字段）。 */
export interface SparkEngines {
  readonly resonance?: ResonantMemoryPort | undefined;
  readonly vortex?: VortexRingSpillAdapter | undefined;
  readonly annealer?: MemoryAnnealer | undefined;
  readonly web?: CosmicWebPort | undefined;
  readonly qec?: QECEncoder | undefined;
  readonly immune?: ImmuneMonitorPort | undefined;
  readonly immuneSample?: (() => readonly number[]) | undefined;
  readonly naturalGradient?: NaturalGradientBelief | undefined;
  readonly particleFilter?: ParticleFilterBelief | undefined;
  readonly beliefObservation?: (() => readonly number[]) | undefined;
  readonly crispr?: CRISPRSkillEditor | undefined;
  readonly crystallizer?: CapabilityCrystallizer | undefined;
  readonly etching?: InsightEtchingEngine | undefined;
  readonly etchProbe?: (() => string) | undefined;
  readonly elementComposer?: ElementComposer | undefined;
  readonly composeProbe?: (() => readonly string[]) | undefined;
  readonly symmetry?: SymmetryBreakingEngine | undefined;
  readonly symmetryProbe?: (() => readonly { capability: string; weight: number }[]) | undefined;
  readonly confinement?: ConfinementEngine | undefined;
  readonly confinementProbe?: (() => CapabilityCharge) | undefined;
}

/** 算子执行结果（统一代数形态）。 */
export interface HarnessOperatorResult {
  readonly next: HarnessState;
  readonly cost: Cost;
  /** 引擎原生报告片段（undefined 表示该算子本轮回合未触发）。 */
  readonly report: unknown;
  readonly events: ReadonlyArray<string>;
}

/** 仿生算子：状态的真实变换（指称语义）。 */
export type HarnessOperator = (state: HarnessState, engines: SparkEngines) => HarnessOperatorResult;

const KINDS: ModalityKind[] = ['text', 'image', 'audio', 'tensor', 'video'];

/** 由信号派生代数 Regime（模态数 → 具体模态种类列表，供 plan 判定）。 */
export function deriveRegime(s: RegimeSignals): Regime {
  const modalities: ModalityKind[] = [];
  for (let i = 0; i < Math.max(1, s.modalityCount); i++) {
    const k = KINDS[i % KINDS.length];
    if (k !== undefined) modalities.push(k);
  }
  return {
    entropy: s.entropy,
    modalities,
    costPressure: Math.max(0, Math.min(1, s.costPressure)),
  };
}

/** 引擎缺失时的单位元结果（不耗资源、无报告）。 */
function noop(state: HarnessState): HarnessOperatorResult {
  return { next: state, cost: emptyCost, report: undefined, events: [] };
}

// ---- 九个仿生算子：真实调用既有引擎（镜像 SparkController.cycle） ----

export const opResonance: HarnessOperator = (state, e) => {
  const r = e.resonance?.tune();
  if (r === undefined) return noop(state);
  return { next: state, cost: cost(5), report: r, events: ['resonance'] };
};

export const opVortex: HarnessOperator = (state, e) => {
  const r = e.vortex?.flush();
  if (r === undefined) return noop(state);
  return { next: state, cost: cost(5), report: r, events: ['vortex'] };
};

export const opHeatAnnealer: HarnessOperator = (state, e) => {
  const r = e.annealer?.anneal();
  if (r === undefined) return noop(state);
  return {
    next: { ...state, temperature: (r as AnnealStepReport).temperature },
    cost: cost(20),
    report: r,
    events: ['heatAnnealer'],
  };
};

export const opWeb: HarnessOperator = (state, e) => {
  const r = e.web?.consolidate();
  if (r === undefined) return noop(state);
  return { next: state, cost: cost(8), report: r, events: ['web'] };
};

export const opQec: HarnessOperator = (state, e) => {
  const r = e.qec?.repairAll();
  if (r === undefined) return noop(state);
  return { next: state, cost: cost(8), report: r, events: ['qec'] };
};

export const opImmuneMonitoring: HarnessOperator = (state, e) => {
  if (e.immune === undefined) return noop(state);
  const sample = e.immuneSample?.();
  if (sample !== undefined) e.immune.observe(sample);
  const r = e.immune.selfCheck();
  return { next: state, cost: cost(10), report: r, events: ['immuneMonitoring'] };
};

export const opBelief: HarnessOperator = (state, e) => {
  const obs = e.beliefObservation?.();
  if (obs === undefined) return noop(state);
  const ng = e.naturalGradient?.correct(obs);
  const pf = e.particleFilter?.correct(obs);
  const report =
    ng !== undefined || pf !== undefined
      ? {
          naturalGradient: ng as BeliefUpdateReport | undefined,
          particleFilter: pf as BeliefUpdateReport | undefined,
        }
      : undefined;
  if (report === undefined) return noop(state);
  return { next: state, cost: cost(15), report, events: ['belief'] };
};

export const opCrispr: HarnessOperator = (state, e) => {
  const r = e.crispr?.flush();
  if (r === undefined || r.length === 0) return noop(state);
  return { next: state, cost: cost(6), report: r, events: ['crispr'] };
};

export const opCapabilityCrystallizer: HarnessOperator = (state, e) => {
  const r = e.crystallizer?.crystallize();
  if (r === undefined) return noop(state);
  return { next: state, cost: cost(15), report: r, events: ['capabilityCrystallizer'] };
};

export const opEtching: HarnessOperator = (state, e) => {
  if (e.etching === undefined) return noop(state);
  const traces = e.etching.traces;
  const conducted =
    e.etchProbe !== undefined
      ? e.etching.conduct(e.etchProbe()).flatMap((c: EtchConduction) => c.path)
      : undefined;
  return { next: state, cost: cost(6), report: { traces, conducted }, events: ['etching'] };
};

export const opElementComposer: HarnessOperator = (state, e) => {
  if (e.elementComposer === undefined) return noop(state);
  const elements = e.elementComposer.elements().length;
  const compound = e.composeProbe
    ? (e.elementComposer.compose(e.composeProbe())?.symbol ?? null)
    : null;
  return {
    next: state,
    cost: cost(8),
    report: { elements, compound },
    events: ['elementComposer'],
  };
};

export const opSymmetryBreaking: HarnessOperator = (state, e) => {
  if (e.symmetry === undefined) return noop(state);
  const s = e.symmetryProbe?.();
  if (s !== undefined) e.symmetry.observe(s);
  const r = e.symmetry.snapshot();
  return {
    next: { ...state, orderParameter: r.orderParameter ?? state.orderParameter },
    cost: cost(12),
    report: r,
    events: ['symmetryBreaking'],
  };
};

export const opConfinement: HarnessOperator = (state, e) => {
  if (e.confinement === undefined || e.confinementProbe === undefined) return noop(state);
  const r = e.confinement.expose(e.confinementProbe());
  return {
    next: { ...state, exposed: (r as ConfinementVerdict).exposed },
    cost: cost(12),
    report: r,
    events: ['confinement'],
  };
};

/** 算子名 → 算子实现（与 SparkCycleReport 字段一一对应，见 sparkBridge 映射）。 */
export const HARNESS_OPERATORS: Readonly<Record<string, HarnessOperator>> = {
  resonance: opResonance,
  vortex: opVortex,
  heatAnnealer: opHeatAnnealer,
  web: opWeb,
  qec: opQec,
  immuneMonitoring: opImmuneMonitoring,
  belief: opBelief,
  crispr: opCrispr,
  capabilityCrystallizer: opCapabilityCrystallizer,
  etching: opEtching,
  elementComposer: opElementComposer,
  symmetryBreaking: opSymmetryBreaking,
  confinement: opConfinement,
};

/**
 * 自适应管线规划（纯函数）：依工况重排算子发射顺序。
 * - 高成本压力：退火/冷却优先，剪掉昂贵尾算子（降本，对应报告 #18 的"能耗入适应度"）。
 * - 高熵（混乱）：先建立秩序（对称破缺 + 禁闭）再生长。
 * - 默认：沿用既有稳定顺序。
 */
export function planHarnessRegime(regime: Regime): readonly string[] {
  const base = [
    'resonance',
    'vortex',
    'heatAnnealer',
    'web',
    'qec',
    'immuneMonitoring',
    'belief',
    'crispr',
    'capabilityCrystallizer',
    'etching',
    'elementComposer',
    'symmetryBreaking',
    'confinement',
  ];
  if (regime.costPressure > 0.7) {
    return [
      'heatAnnealer',
      'web',
      'qec',
      'immuneMonitoring',
      'belief',
      'symmetryBreaking',
      'confinement',
    ];
  }
  if (regime.entropy > 0.5 && regime.modalities.length >= 3) {
    return [
      'symmetryBreaking',
      'confinement',
      'resonance',
      'vortex',
      'heatAnnealer',
      'web',
      'qec',
      'immuneMonitoring',
      'belief',
      'crispr',
      'capabilityCrystallizer',
      'etching',
      'elementComposer',
    ];
  }
  return base;
}
