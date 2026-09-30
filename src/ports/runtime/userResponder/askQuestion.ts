import type { AskOption } from './askOption.js';

/**
 * @beta
 * 模型抛给用户的单个问题。
 */
export interface AskQuestion {
  /** 稳定 id，将在答案中原样回显。 */
  readonly id: string;
  /** 具体问题。 */
  readonly question: string;
  /** 可选短标题（如 "确认" / "选择模式"）。 */
  readonly header?: string;
  /** 可选选项；若想推荐某一项，把它放第一并追加 "(推荐)"。 */
  readonly options?: readonly AskOption[];
  /** 是否允许多选，默认 false。 */
  readonly multiSelect?: boolean;
}
