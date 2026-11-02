import type { ResonantMemoryPort } from '../memory/resonantMemory/resonantMemoryPort.ts';
import type { MemoryAnnealer } from '../memory/memoryAnnealing/memoryAnnealer.ts';
import type { CosmicWebPort } from '../memory/cosmicWeb/cosmicWebPort.ts';
import type { ImmuneMonitorPort } from '../intelligence/immune/immuneMonitorPort.ts';
import type { MetacognitionPort } from '../intelligence/metacognition/metacognitionPort.ts';
import type { QECEncoderPort } from '../intelligence/qec/qecEncoderPort.ts';
import type { CRISPRSkillEditorPort } from '../runtime/skillEdit/crisprSkillEditorPort.ts';
import type { CapabilityCrystallizerPort } from '../intelligence/capability/capabilityCrystallizerPort.ts';
import type { InsightEtchingPort } from '../memory/insightEtching/insightEtchingPort.ts';
import type { ElementComposerPort } from '../intelligence/elementComposer/elementComposerPort.ts';
import type { SymmetryBreakingPort } from '../intelligence/symmetryBreaking/symmetryBreakingPort.ts';
import type { ConfinementPort } from '../runtime/confinement/confinementPort.ts';
import type { CapabilityCharge } from '../runtime/confinement/capabilityCharge.ts';
import type { VortexRingSpillAdapterPort } from '../memory/spill/vortexRingSpillAdapterPort.ts';

/**
 * @beta
 * 算子所需的真实引擎集合（镜像 SparkControllerOptions 的引擎字段）。
 *
 * 字段类型已统一为 ports 层契约（不再引用 `adapters/*` 具体实现），从而可在 `ports/genesis`
 * 定义而不触发 `ports→adapters` 禁边。原 `genesis/operators.ts` 因引用大量 adapter 类型被暂缓
 * （见 `regimeSignals.ts` 历史注释）；现各引擎类均已 `implements` 对应端口，`SparkEngineSet
 * .toGenesisEngines` 注入的具体实例结构可代入本契约。
 */
export interface SparkEngines {
  readonly resonance?: ResonantMemoryPort | undefined;
  readonly vortex?: VortexRingSpillAdapterPort | undefined;
  readonly annealer?: MemoryAnnealer | undefined;
  readonly web?: CosmicWebPort | undefined;
  readonly qec?: QECEncoderPort | undefined;
  readonly immune?: ImmuneMonitorPort | undefined;
  readonly immuneSample?: (() => readonly number[]) | undefined;
  readonly naturalGradient?: MetacognitionPort | undefined;
  readonly particleFilter?: MetacognitionPort | undefined;
  readonly beliefObservation?: (() => readonly number[]) | undefined;
  readonly crispr?: CRISPRSkillEditorPort | undefined;
  readonly crystallizer?: CapabilityCrystallizerPort | undefined;
  readonly etching?: InsightEtchingPort | undefined;
  readonly etchProbe?: (() => string) | undefined;
  readonly elementComposer?: ElementComposerPort | undefined;
  readonly composeProbe?: (() => readonly string[]) | undefined;
  readonly symmetry?: SymmetryBreakingPort | undefined;
  readonly symmetryProbe?: (() => readonly { capability: string; weight: number }[]) | undefined;
  readonly confinement?: ConfinementPort | undefined;
  readonly confinementProbe?: (() => CapabilityCharge) | undefined;
}
