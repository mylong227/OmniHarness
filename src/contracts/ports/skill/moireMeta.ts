/**
 * 莫尔组合元数据：记录本技能由哪两个技能、在哪种相对转角下组合而成，
 * 以及涌现强度。仅当技能由 `SkillPort.composeByTwist` 生成时存在。
 */
export interface MoireMeta {
  /** 来源技能名 [a, b]。 */
  readonly composedFrom: readonly [string, string];
  /** 涌现峰值相对转角（度）。 */
  readonly twistDeg: number;
  /** 涌现强度 0..1：乘积场低频频谱能量占比（越高 = 长波结构越强）。 */
  readonly emergence: number;
  /** 该组合是否越过涌现接纳下限（emergenceFloor），未越过者不具生产力、被固化器拒收。 */
  readonly accepted?: boolean;
  /** 能力场边长 N（扁平长度为 N*N）。 */
  readonly fieldSize: number;
}
