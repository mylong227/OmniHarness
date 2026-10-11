/**
 * @beta
 * 技能端口：六边形端口体系中技能的来源与组合面。
 * 实现可注册/匹配技能，并提供燧-1 莫尔转角组合算子（composeByTwist）。
 *
 * 2026-10-11：类型从**实现层的再导出桶**（`../../skill/skill.js`）改为直连 `ports/skill/*`。
 * 那几个类型本来就住在 ports 里（`skill/skill.ts` 只是一层 `export type … from` 桶），
 * 端口却绕道实现文件去取它们 —— 这正是 `architectureGate` 的 `ports→实现层` 规则要拦的形状，
 * 也是本仓 G25 记录的同一类"类型已在 ports、调用点却绕道"的老毛病。
 */
import type { MoireMeta } from '../skill/moireMeta.js';
import type { MoireOptions } from '../skill/moireOptions.js';
import type { Skill } from '../skill/skill.js';

export type { MoireMeta } from '../skill/moireMeta.js';
export type { MoireOptions } from '../skill/moireOptions.js';

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
