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
}

/** 工具执行上下文。 */
export interface ToolContext {
  readonly sessionId: string;
  readonly workspaceRoot: string;
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
