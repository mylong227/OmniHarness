/** 莫尔组合选项（燧-1 组合算子用）。 */
export interface MoireOptions {
  /** 能力场边长（默认 32）。 */
  readonly fieldSize?: number;
  /** 低通半径（默认 2）。 */
  readonly blurRadius?: number;
  /** 转角扫描步长（度，默认 3）。 */
  readonly thetaStepDeg?: number;
  /** 最小相对转角（度，默认 3，0°=无扭转）。 */
  readonly minTwistDeg?: number;
  /** 最大相对转角（度，默认 87）。 */
  readonly maxTwistDeg?: number;
  /** 涌现接纳下限（默认 0 = 全接纳）：组合峰值涌现低于此值视为不具生产力、被固化器拒收。 */
  readonly emergenceFloor?: number;
}
