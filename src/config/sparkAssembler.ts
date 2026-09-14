import { SparkController } from '../spark/sparkController.js';
import type { VortexRingSpillAdapter } from '../adapters/spill/vortexRingSpillAdapter.js';

import type { MemoryStackAssembly } from './memoryStackAssembler.js';
import type { SkillStack } from './skillStackAssembler.js';
import type { OmniHarnessConfig } from './configFactory.js';

/**
 * SparkAssembler 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class SparkAssembler {
  /**
   * 任一燧能力（引擎、外溢封包或遥测）存在即为活跃。
   * @param partial OmniHarnessConfig
   * @param input SparkAssemblyInput
   * @returns boolean
   */
  public static hasActiveEngine(partial: OmniHarnessConfig, input: SparkAssemblyInput): boolean {
    const { annealer, qecEncoder, immune, naturalGradient, particleFilter, web } =
      input.memory.stack;
    const { resonance } = input.memory.sparkInput;
    const { crispr, crystallizer, etching, elementComposerEngine, symmetry, confinementEngine } =
      input.skills;
    return (
      resonance !== undefined ||
      input.vortex !== undefined ||
      annealer !== undefined ||
      web !== undefined ||
      qecEncoder !== undefined ||
      immune !== undefined ||
      naturalGradient !== undefined ||
      particleFilter !== undefined ||
      crispr !== undefined ||
      crystallizer !== undefined ||
      etching !== undefined ||
      elementComposerEngine !== undefined ||
      symmetry !== undefined ||
      confinementEngine !== undefined ||
      partial.runtimeTelemetry !== undefined
    );
  }
}

/** 燧内核装配输入：已封包的外溢/记忆/技能三栈。 */
export interface SparkAssemblyInput {
  /** 燧-4 涡环包外溢适配器（`vortexRing.enabled` 时非空）。 */
  readonly vortex: VortexRingSpillAdapter | undefined;
  /** 长期记忆栈装配结果（含燧专用内部件）。 */
  readonly memory: MemoryStackAssembly;
  /** 技能 / 能力算子栈切片。 */
  readonly skills: SkillStack;
}

/**
 * 装配燧内核控制器（S+ 发明层组合根一侧）。
 *
 * 把已封包的 燧-3 共振 / 燧-4 涡环包 / (D) 退火 / (E) 宇宙网·QEC·免疫 / (P2) 信念 /
 * (P2-P3) 技能与能力算子，统一挂到 `SparkController` 的 `autoRun` 钩子上——任务末跑一轮
 * 调谐 / 冲刷 / 校验，fail-closed 且异常不影响主任务。
 *
 * 铁律：**无活跃燧能力时不构造控制器**（返回 undefined），主循环零开销、零破坏旁路。
 * 探针（etchProbe / composeProbe / symmetryProbe / confinementProbe）为各算子的确定性自检输入，
 * 仅当对应引擎存在时才挂载。
 *
 * @param partial 未解析的运行配置（读取 `sparkAutoRun` / `runtimeTelemetry` / `genesis`）。
 * @param input 外溢 / 记忆 / 技能三栈。
 * @returns 有任一活跃燧能力时返回控制器，否则 undefined。
 */
export function assembleSpark(
  partial: OmniHarnessConfig,
  input: SparkAssemblyInput,
): SparkController | undefined {
  if (!SparkAssembler.hasActiveEngine(partial, input)) {
    return undefined;
  }
  const { vortex, memory, skills } = input;
  const { annealer, qecEncoder, immune, naturalGradient, particleFilter, web } = memory.stack;
  const { resonance, immuneSample, beliefObservation } = memory.sparkInput;
  return new SparkController({
    resonance,
    vortex,
    annealer,
    web,
    qec: qecEncoder,
    immune,
    immuneSample,
    naturalGradient,
    particleFilter,
    beliefObservation,
    crispr: skills.crispr,
    crystallizer: skills.crystallizer,
    etching: skills.etching,
    etchProbe: skills.etching === undefined ? undefined : () => 'default-probe-query',
    elementComposer: skills.elementComposerEngine,
    composeProbe: skills.elementComposerEngine === undefined ? undefined : () => ['Na', 'Cl'],
    symmetry: skills.symmetry,
    symmetryProbe:
      skills.symmetry === undefined ? undefined : () => [{ capability: 'core-skill', weight: 1 }],
    confinement: skills.confinementEngine,
    confinementProbe:
      skills.confinementEngine === undefined
        ? undefined
        : () => ({
            id: 'probe-bare',
            charge: { color: 1, flavor: 0, permission: 0, expiry: 0 },
          }),
    telemetry: partial.runtimeTelemetry,
    autoRun: partial.sparkAutoRun === true,
    enableGenesis: partial.genesis?.enabled === true,
    genesisSignals: partial.genesis?.signals,
  });
}
