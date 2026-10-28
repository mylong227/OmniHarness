/** 模型返回的工具调用引用。 */
export interface ModelToolCallRef {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** 参数 JSON 不可修复时的错误说明（见 `ToolCall.parseError`）。 */
  readonly parseError?: string | undefined;
  /**
   * Gemini `thoughtSignature`（可选）：函数调用携带的思考签名，下一轮必须原样回传，
   * 否则多轮思考 + 工具会丢上下文/降质。
   */
  readonly thoughtSignature?: string | undefined;
}
