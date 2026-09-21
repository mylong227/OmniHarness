import type { FileAttachment } from '../model/model.js';

/** 工具参数 JSON Schema 最小子集。 */
export interface ToolParametersSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
}

/** 工具定义：名称 + 描述 + 参数约束。 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParametersSchema;
  /**
   * 延迟加载：为 true 时默认不注入模型上下文（需经 `tool_search` 发现后才可见）。
   * 用于工具众多时省上下文（#M1）。缺省为 false（始终可见）。
   */
  readonly deferred?: boolean;
}

/** 模型发起的工具调用。 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** 工具执行结果。 */
export interface ToolResult {
  readonly callId: string;
  readonly ok: boolean;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  /**
   * 工具产出的**文件附件**（可选，P2-⑬）：供 `view_image` 这类「把字节交给模型」的工具使用。
   * 图片类附件由模型适配器作为图像理解；其余以文本说明注入模型上下文。
   *
   * 通道走向：工具结果事件 → 上下文组装器 → 模型消息。组装器会把它们作为**独立的一条
   * user 消息**追加在所有 tool 消息之后（而不是塞进 tool 消息内）——OpenAI 兼容端点不保证
   * tool 消息能携带分段内容，且把附件插在 tool 消息之间会破坏 tool_call 配对。
   */
  readonly files?: readonly FileAttachment[] | undefined;
}

/** 工具执行上下文。 */
export interface ToolContext {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  /**
   * 会话取消信号（V2 取消传播，可选）：由 `StepToolExecutor` 从本会话取消令牌注入。
   * 长任务工具（subagent / run_workflow / run_goal）据此把取消下传子代，
   * 使父取消后子代尽快收尾；缺省 undefined＝调用方未接取消链。
   */
  readonly signal?: AbortSignal | undefined;
}

/** 工具端口：一切工具能力（内置/外部服务/自定义）的统一插口。 */
export interface ToolPort {
  readonly name: string;
  list(): readonly ToolDefinition[];
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  /**
   * 反注册工具（插件卸载时回收其注册的工具，避免孤儿工具残留）。
   * 可选：不支持反注册的端口可省略，此时插件工具在卸载后仍需手动清理。
   */
  unregister?(name: string): boolean;
  /**
   * 供模型上下文使用的工具子集（剔除 deferred 工具）。
   * 缺省回退 `list()`；延迟加载机制依赖此方法与 `tool_search` 协同（#M1）。
   */
  listDirect?(): readonly ToolDefinition[];
}
