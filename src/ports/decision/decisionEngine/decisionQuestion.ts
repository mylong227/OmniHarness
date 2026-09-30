import type { DecisionKind } from './decisionKind.js';

/** 单题定义（参考 Laya 的 questions 字典项）。 */
export interface DecisionQuestion {
  /** 原语类型。 */
  readonly kind: DecisionKind;
  /** 对模型的指令 / 问题陈述。 */
  readonly instructions: string;
  /**
   * 选项定义：`choice` 为 `{类别: 描述}`；`score` 为有序等级标签数组；
   * `noul` 一般不带 criteria（只问「是/否」概率）。
   */
  readonly criteria?: Readonly<Record<string, string>> | readonly string[];
}
