import type { EtchBranch } from './etchBranch.js';

/** 一次顿悟事件（待刻蚀）。 */
export interface EtchEvent {
  /** 唯一 ID。 */
  readonly id: string;
  /** 事件主标签。 */
  readonly label: string;
  /** 分支决策树（分形 trace 的骨架）。 */
  readonly branches?: readonly EtchBranch[];
}
