import type { Charge } from './charge.js';

/** 两能力束缚后的单态能力。 */
export interface BoundCapability {
  /** 束缚态 ID。 */
  readonly id: string;
  /** 成员能力 ID 序列。 */
  readonly members: readonly string[];
  /** 束缚态色荷（必为单态：全 0）。 */
  readonly charge: Charge;
}
