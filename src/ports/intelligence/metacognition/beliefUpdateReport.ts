import type { BeliefSnapshot } from './beliefSnapshot.js';
import type { BeliefKlComponent } from './beliefKlComponent.js';

/** 一次信念更新的可审计报告。 */
export interface BeliefUpdateReport {
  /** 更新前快照。 */
  readonly before: BeliefSnapshot;
  /** 更新后快照。 */
  readonly after: BeliefSnapshot;
  /** 可审计 KL 分解（KL(after ‖ before)，信息几何）：总量 + 命名分量 + 逐维明细。 */
  readonly kl: {
    /** KL 总量。 */
    readonly total: number;
    /** 纯均值漂移分量之和。 */
    readonly meanShift: number;
    /** 纯方差变化分量之和。 */
    readonly variance: number;
    /** 逐维明细（顺序与维度一致）。 */
    readonly perDimension: ReadonlyArray<BeliefKlComponent>;
  };
  /**
   * 重参数化不变性审计：把信念维度排列后重算总 KL，应与原总 KL 一致（坐标图无关）。
   * 信息几何铁律——KL 是流形上的标量，不依赖维度排序这一坐标表示。
   */
  readonly reparamInvariant: boolean;
}
