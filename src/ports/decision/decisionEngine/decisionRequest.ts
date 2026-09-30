import type { DecisionQuestion } from './decisionQuestion.js';

/** 一次决策请求（待判断的 state + 问题集）。 */
export interface DecisionRequest {
  /** 待判断的文本状态（代码 / 邮件 / 工单 / JSON 文档等）。 */
  readonly state: string;
  /** 问题集，键为问题名。 */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}
