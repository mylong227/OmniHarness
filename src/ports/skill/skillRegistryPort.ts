import type { MoireMeta } from './moireMeta.js';
import type { MoireOptions } from './moireOptions.js';
import type { Skill } from './skill.js';
import type { SkillRetrieveHit } from './skillRetrieveHit.js';

/**
 * @beta
 * 技能注册表端口：配置面（`ports/config/*`）只需"能注册/查询/组合技能"，不需要实现类。
 *
 * 2026-10-11：原先配置面字段直接用实现类 `SkillRegistry`（`ports→实现层` 禁边）。本接口列的是
 * 该类的**全部公开实例方法**（`src/skill/skillRegistry.ts`），故实现类结构性满足它、
 * 注入处零改动；同时把"配置面到底用得到技能注册表的哪些能力"变成**可读的契约**。
 *
 * 不含构造器：注册表的选择预算（`SkillSelectOptions`）由组合根在构造时决定，属实现细节。
 */
export interface SkillRegistryPort {
  /**
   * 注册技能（重名即抛错）。
   *
   * @param skill 技能。
   * @returns 无返回值。
   */
  register(skill: Skill): void;

  /**
   * 原地替换既有技能（存在则覆盖，不存在则注册）。
   *
   * @param skill 技能。
   * @returns 无返回值。
   */
  replace(skill: Skill): void;

  /**
   * 按名移除技能（幂等）。
   *
   * @param name 技能名。
   * @returns 存在且已移除为 `true`；不存在为 `false`。
   */
  remove(name: string): boolean;

  /**
   * 全部技能（按注册顺序）。
   *
   * @returns 技能数组。
   */
  list(): readonly Skill[];

  /**
   * 字面匹配（文本含技能名或任一 tag 即命中）。
   *
   * @param text 提示文本。
   * @returns 命中的技能。
   */
  match(text: string): readonly Skill[];

  /**
   * 相关性选择（生产注入路径）。
   *
   * @param text 提示文本。
   * @returns 选中的技能（按相关度）。
   */
  selectForPrompt(text: string): readonly Skill[];

  /**
   * 相关性排序（带得分，供观测/调试）。
   *
   * @param text 提示文本。
   * @returns 命中及其 BM25 得分。
   */
  rankForPrompt(text: string): readonly SkillRetrieveHit[];

  /**
   * 按名取技能。
   *
   * @param name 技能名。
   * @returns 技能；不存在为 `undefined`。
   */
  get(name: string): Skill | undefined;

  /**
   * 把技能渲染成注入用的文本块。
   *
   * @param skill 技能。
   * @returns 渲染结果。
   */
  render(skill: Skill): string;

  /**
   * 燧-1 莫尔转角组合算子。
   *
   * @param a 技能 A。
   * @param b 技能 B。
   * @param opts 组合选项（缺省取出厂口径）。
   * @returns 组合后的技能（附 `moire` 元信息）。
   */
  composeByTwist(a: Skill, b: Skill, opts?: MoireOptions): Skill & { moire: MoireMeta };
}
