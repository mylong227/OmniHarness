/**
 * @beta
 * 用户对单个问题的回答。
 */
export interface AskAnswer {
  /** 与问题 id 对应。 */
  readonly id: string;
  /** 选中的选项标签（多选时为多个）。 */
  readonly selected: readonly string[];
  /** 用户自由输入（当未从选项中选择、或需要补充时）。 */
  readonly custom?: string;
}
