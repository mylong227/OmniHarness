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
 * MCP **非文本**内容块（图 / 音 / 资源链接 / 内嵌资源 / 未知形状）的保真转述（G10/T3，2026-10-03）。
 *
 * ## 为什么要有它
 *
 * 适配器原先把**一切非文本块**收敛成 `{type:'text', text:''}`——即**静默丢块**：远端返回一张图或一个
 * 资源链接，模型侧只看到一段空白，且无从知道"那里本来有东西"。
 *
 * ## 口径
 *
 *  - `text`：该块的**文本化转述**（例如 `[图片 image/png，base64 1.2 KB]` 或资源链接的 URI）。
 *    它保证"只吃文本"的上游（网关 → 工具结果 → 模型）至少**看得见**块的存在与类型；
 *    与 {@link McpTextContent} 一样都有 `text` 字段 ⇒ 既有 `content.map(c => c.text)` 调用点零改动。
 *  - `raw`：**原始块**原样保留（能处理富内容的调用方不必回头再问一次远端）。
 *  - `type`：`unknown` 表示形状超出本仓建模范围——仍然转述为 JSON 摘要，**绝不塌成空串**。
 */
export interface McpRichContent {
  /** 块类型（`unknown` ＝ 形状未建模，仍以 JSON 摘要转述）。 */
  readonly type: 'image' | 'audio' | 'resource_link' | 'resource' | 'unknown';
  /** 该块的文本化转述（供只吃文本的上游；保证非空）。 */
  readonly text: string;
  /** 原始块（保真保留，供能处理富内容的调用方）。 */
  readonly raw: unknown;
}

/**
 * @beta
 * MCP 内容块（文本或非文本）。
 */
export type McpContentBlock = McpTextContent | McpRichContent;

/**
 * @beta
 * MCP 工具调用结果。
 */
export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError: boolean;
  /**
   * **结构化输出**（`structuredContent`，G10/T3）：远端按 `outputSchema` 返回的机器可读结果。
   *
   * 此前被适配器**直接丢弃**（只看 `content`）。现在原样透出，由网关渲染进工具结果文本
   * （模型据此可读到结构化字段，而不必依赖远端是否同时给了文本块）。
   */
  readonly structuredContent?: unknown;
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
