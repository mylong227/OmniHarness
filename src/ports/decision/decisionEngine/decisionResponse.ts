import type { DecisionAnswer } from './decisionAnswer.js';

/** 决策响应。 */
export interface DecisionResponse {
  /** 各题答案，键与请求问题集对齐。 */
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** 实际使用的模型 / checkpoint 标识。 */
  readonly model?: string;
  /** 引擎是否可用（不可用时调用方回落 LLM，fail-open）。 */
  readonly available: boolean;
  /** 不可用 / 退化原因（可选）。 */
  readonly note?: string;
}
