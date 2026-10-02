/**
 * MCP 协议词汇表（端口层单一来源）。
 *
 * 已从 `src/mcp/mcpProtocol.ts` 外迁到 ports/mcp（2026-10-02，客户端方向迁官方 SDK 的前置）：
 * 原文件退化为纯再导出桶，调用点零改动。外迁原因：MCP 客户端端口（{@link ./mcpClientPort.ts}）
 * 与连接器端口（{@link ./mcpConnectorPort.ts}）都要引用这些类型，而 ports 层不能反向依赖
 * src/mcp 实现——类型必须住在比二者都深的一层。
 *
 * 本文件只有**类型**（无 class、无第三方、无逻辑），符合端口纯度门禁。
 * 运行时协议常量（方法名 / 版本号）仍留在 `src/mcp/mcpProtocol.ts` 的 `McpProtocol` 类。
 */

/**
 * @beta
 * MCP 输入 schema（与 OmniHarness ToolParametersSchema 同构）。
 */
export interface McpInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
}

/**
 * @beta
 * MCP 工具描述（tools/list 返回项）。
 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpInputSchema;
}

/**
 * @beta
 * MCP 文本内容块。
 */
export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * @beta
 * MCP 工具调用结果。
 */
export interface McpCallToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError: boolean;
}

/**
 * @beta
 * MCP 服务端信息。
 */
export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * @beta
 * MCP 资源描述（resources/list 返回项）。
 */
export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/**
 * @beta
 * MCP 资源读取结果。
 */
export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
}

/**
 * @beta
 * MCP 提示模板描述（prompts/list 返回项）。
 */
export interface McpPromptDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
}

/**
 * @beta
 * MCP 能力声明（tools / resources / prompts）。
 */
export interface McpCapabilities {
  readonly tools?: Record<string, never>;
  readonly resources?: Record<string, never>;
  readonly prompts?: Record<string, never>;
}

/**
 * @beta
 * MCP initialize 结果。
 */
export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpCapabilities;
  readonly serverInfo: McpServerInfo;
}
