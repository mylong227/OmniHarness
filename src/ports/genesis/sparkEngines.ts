import type { ResonantMemoryPort } from '../memory/resonantMemory/resonantMemoryPort.js';
import type { MemoryAnnealer } from '../memory/memoryAnnealing/memoryAnnealer.js';
import type { CosmicWebPort } from '../memory/cosmicWeb/cosmicWebPort.js';
import type { ImmuneMonitorPort } from '../intelligence/immune/immuneMonitorPort.js';
import type { MetacognitionPort } from '../intelligence/metacognition/metacognitionPort.js';
import type { QECEncoderPort } from '../intelligence/qec/qecEncoderPort.js';
import type { CRISPRSkillEditorPort } from '../runtime/skillEdit/crisprSkillEditorPort.js';
import type { CapabilityCrystallizerPort } from '../intelligence/capability/capabilityCrystallizerPort.js';
import type { InsightEtchingPort } from '../memory/insightEtching/insightEtchingPort.js';
import type { ElementComposerPort } from '../intelligence/elementComposer/elementComposerPort.js';
import type { SymmetryBreakingPort } from '../intelligence/symmetryBreaking/symmetryBreakingPort.js';
import type { ConfinementPort } from '../runtime/confinement/confinementPort.js';
import type { CapabilityCharge } from '../runtime/confinement/capabilityCharge.js';
import type { VortexRingSpillAdapterPort } from '../memory/spill/vortexRingSpillAdapterPort.js';

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
