import type { Skill } from '../../../skill/skill.js';

/** 候选能力（待评估晋升者）：一个组合/发现的技能 + 其来源与诊断元信息。 */
export interface Candidate {
  /** 待晋升候选技能。 */
  readonly skill: Skill;
  /** 来源标识（如 'twist:a+b' / 'incumbent'）。 */
  readonly source: string;
  /** 任意诊断元信息（如涌现强度、转角）。 */
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}
