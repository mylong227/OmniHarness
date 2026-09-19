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

/**
 * @beta
 * 技能：声明式能力包，命中时注入上下文指导模型行为（SKILL.md 思路）。
 *
 * `capabilityField` 与 `moire` 为可选扩展：莫尔组合算子（燧-1）使用它们刻画
 * 并承载「两技能都没有的涌现长波能力」。无此字段的旧技能完全向后兼容。
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tags?: readonly string[];
  /**
   * 可选能力场（扁平 N*N 的二维正弦光栅，值 ∈ [-1,1]）。
   * 缺省时由组合器按技能文本确定性派生（可复现、非随机）。
   */
  readonly capabilityField?: readonly number[];
  /** 若本技能由莫尔组合而来，记录来源/转角/涌现强度。 */
  readonly moire?: MoireMeta;
  /**
   * 若本技能由相变固化（I-P2-5）冻结而来：标记为真，并记录来源组合。
   * 可选字段，向后兼容——旧技能不携带。
   */
  readonly frozen?: boolean;
  /** 相变固化来源组合（frozen=true 时非空）。 */
  readonly frozenFrom?: readonly string[];
}

/**
 * **声明式技能子集**：配置文件 / CLI 可注入的字段。
 *
 * 为什么单独一个类型（而不是直接收 `Skill`）：`Skill` 里还挂着莫尔组合元数据
 * （`capabilityField` / `moire` / `frozen` / `frozenFrom`）——那些是**运行时/进化**产物，
 * 由组合器与固化器写入。允许外部配置注入它们等于让配置伪造「这技能是涌现/固化来的」，
 * 越过门禁与准入判定。故配置文件与 CLI 只认这一子集，其余字段由运行时自己写。
 */
export type SkillEntry = Pick<Skill, 'name' | 'description' | 'instructions' | 'tags'>;
