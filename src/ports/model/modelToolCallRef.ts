/** 模型返回的工具调用引用。 */
export interface ModelToolCallRef {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** 参数 JSON 不可修复时的错误说明（见 `ToolCall.parseError`）。 */
  readonly parseError?: string | undefined;
}
