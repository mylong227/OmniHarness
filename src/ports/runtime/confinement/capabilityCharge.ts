import type { Charge } from './charge.js';

/** 带色荷的能力。 */
export interface CapabilityCharge {
  /** 能力 ID。 */
  readonly id: string;
  /** 多维色荷。 */
  readonly charge: Charge;
}
