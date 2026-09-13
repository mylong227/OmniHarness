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
 * MCP 能力声明（2025-06-18：tools / resources / prompts）。
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

/**
 * @beta
 * MCP 协议常量与消息构造（零依赖，JSON-RPC 2.0 承载）。
 *
 * 协议常量（版本号 / 方法名 / 错误码）保持 `static readonly` 命名空间；
 * 纯构造逻辑以实例方法暴露，由组合根单例 `mcpProtocol` 统一装配。
 */
export class McpProtocol {
  /** 支持的协议版本（2025-06-18：当前稳定版，与主流 MCP 客户端互操作）。 */
  public static readonly PROTOCOL_VERSION = '2025-06-18';
  /** 方法名：握手。 */
  public static readonly METHOD_INITIALIZE = 'initialize';
  /** 方法名：列举工具。 */
  public static readonly METHOD_TOOLS_LIST = 'tools/list';
  /** 方法名：调用工具。 */
  public static readonly METHOD_TOOLS_CALL = 'tools/call';
  /** 方法名：列举资源。 */
  public static readonly METHOD_RESOURCES_LIST = 'resources/list';
  /** 方法名：读取资源。 */
  public static readonly METHOD_RESOURCES_READ = 'resources/read';
  /** 方法名：列举提示模板。 */
  public static readonly METHOD_PROMPTS_LIST = 'prompts/list';
  /** 方法名：获取提示模板。 */
  public static readonly METHOD_PROMPTS_GET = 'prompts/get';
  /** 方法名：心跳。 */
  public static readonly METHOD_PING = 'ping';
  /** 错误码：方法不存在。 */
  public static readonly ERROR_METHOD_NOT_FOUND = -32601;
  /** 错误码：参数无效。 */
  public static readonly ERROR_INVALID_PARAMS = -32602;

  /** 构造文本内容块。 */
  public text(text: string): McpTextContent {
    return { type: 'text', text };
  }

  /** 由工具结果构造调用结果（失败时 isError=true）。 */
  public toolResult(output: string | undefined, error: string | undefined): McpCallToolResult {
    return error === undefined
      ? { content: [this.text(output ?? '')], isError: false }
      : { content: [this.text(error)], isError: true };
  }

  /** 构造 initialize 结果。 */
  public initializeResult(serverInfo: McpServerInfo): McpInitializeResult {
    return {
      protocolVersion: McpProtocol.PROTOCOL_VERSION,
      // 声明已支持的能力；未配置后端时对应集合为空，但方法仍可应答（符合协议）。
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo,
    };
  }
}

/** 组合根单例：纯构造逻辑的统一装配点。协议常量仍经 `McpProtocol.XXX` 访问。 */
export const mcpProtocol = new McpProtocol();
