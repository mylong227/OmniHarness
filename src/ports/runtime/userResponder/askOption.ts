/**
 * @beta
 * 选项（ask_user 的单条可选项）。
 */
export interface AskOption {
  /** 简短的用户可见选项标签。 */
  readonly label: string;
  /** 一句话说明取舍/影响（可选）。 */
  readonly description?: string;
}
