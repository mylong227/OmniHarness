/**
 * @beta
 * 技能端口：六边形端口体系中技能的来源与组合面。
 * 实现可注册/匹配技能，并提供燧-1 莫尔转角组合算子（composeByTwist）。
 */
import type { MoireOptions, MoireMeta, Skill } from '../skill/skill.js';

export type { MoireOptions, MoireMeta } from '../skill/skill.js';

export interface SkillPort {
  /** 注册技能；重名即抛错。 */
  register(skill: Skill): void;
  /** 原地替换既有技能（CRISPR 定点编辑用）：存在则覆盖，不存在则注册。 */
  replace(skill: Skill): void;
  /** 全部技能。 */
  list(): readonly Skill[];
  /** 按名称取技能。 */
  get(name: string): Skill | undefined;
  /** 按需匹配：文本命中技能名或任一 tag。 */
  match(text: string): readonly Skill[];
  /**
   * 莫尔转角组合：扫描相对转角 θ 找涌现峰值 θ*，生成承载涌现长波的新复合技能。
   * 这是「市面唯一」的组合算子——非线性乘积 + 相对扭转，而非加权/拼接。
   */
  composeByTwist(a: Skill, b: Skill, opts?: MoireOptions): Skill & { moire: MoireMeta };
}
