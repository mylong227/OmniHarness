/** 流式工具输入增量（#B3）：模型边生成工具参数边推送，用于渐进渲染工具调用参数。 */
export interface ToolInputDelta {
  /** 工具调用 id（Anthropic 在 block start 给出，OpenAI 在首个 tool_calls delta 给出）。 */
  readonly id?: string | undefined;
  /** 工具名。 */
  readonly name?: string | undefined;
  /** 已累积的参数片段（JSON 片段，可能不完整，由消费方自行拼接/解析）。 */
  readonly partialJson: string;
}
