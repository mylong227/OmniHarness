/** 模型发起的工具调用。 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /**
   * 参数 JSON 不可修复时的错误说明（可选）。
   *
   * 执行器在**任何门禁之前**检查它：有值即补一条配对的失败 `tool_result` 并拒绝执行。
   * 空参数执行 `write_file`/`shell` 比"拒绝"危险得多——这是 fail-closed 的落点。
   */
  readonly parseError?: string | undefined;
  /** Gemini `thoughtSignature`：调用携带的思考签名，落事件并供下一轮回传。 */
  readonly thoughtSignature?: string | undefined;
}
