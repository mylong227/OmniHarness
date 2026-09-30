import type { CapabilityCharge } from './capabilityCharge.js';
import type { BoundCapability } from './boundCapability.js';
import type { ConfinementVerdict } from './confinementVerdict.js';

/** 禁闭色荷端口。 */
export interface ConfinementPort {
  /** 群阶（色荷 mod 此值；默认 3，对应 SU(3) 三色）。 */
  readonly groupOrder: number;
  /**
   * 两能力色荷张量收缩（逐维相加 mod 群阶）；得单态(全 0)→束缚能力可暴露，
   * 否则 undefined（fail-closed 拒绝组合）。
   */
  bind(a: CapabilityCharge, b: CapabilityCharge): BoundCapability | undefined;
  /** 单态校验：裸能力(非全 0)→ false（结构性拒绝暴露）。 */
  isSinglet(c: CapabilityCharge): boolean;
  /** 暴露裁决：仅单态能力可暴露；裸/非单态 → confined。 */
  expose(c: CapabilityCharge): ConfinementVerdict;
}
