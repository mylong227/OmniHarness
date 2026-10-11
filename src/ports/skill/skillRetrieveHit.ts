import type { Skill } from './skill.js';

/**
 * @beta
 * 单条技能检索结果。
 *
 * 2026-10-11 从 `src/skill/skillRetriever.ts` 外迁至端口层：`ports/config/resolvedConfig.ts`
 * 与 `ports/skill/skillRegistryPort.ts` 需要它表达检索结果，而类型原先住在实现文件里
 * ⇒ 触发 `ports→实现层` 禁边。原位置改为导入 + 再导出，调用点零改动。
 */
export interface SkillRetrieveHit {
  /** 命中的技能。 */
  readonly skill: Skill;
  /** BM25 得分（越高越相关；可能为负，取决于实现）。 */
  readonly score: number;
}
