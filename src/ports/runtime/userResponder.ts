/**
 * @beta
 * 用户回答能力缝（对标 DeepSeek `packages/interaction/tool-ask-user`）。
 *
 * 模型面工具 `ask_user` 经此端口暂停并等待真人/前端回答案，再作为普通工具结果
 * 喂回 agent 循环。端口实现可替换：TTY 交互、RPC 等待队列、测试注入等。
 */
export interface AskOption {
  /** 简短的用户可见选项标签。 */
  readonly label: string;
  /** 一句话说明取舍/影响（可选）。 */
  readonly description?: string;
}

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

/**
 * @beta
 * 用户回答端口：一切"向人提问"能力的统一插口。
 */
export interface UserResponder {
  readonly name: string;
  ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]>;
}
