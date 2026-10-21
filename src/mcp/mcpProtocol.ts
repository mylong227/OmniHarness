/**
 * @beta
 * MCP 协议类型词汇表（桶再导出）。
 *
 * 类型已外迁到 `ports/mcp/mcpProtocolTypes.ts`（2026-10-02，客户端端口化的前置）；
 * 本文件保留运行时协议常量与消息构造。调用点零改动。
 */
export type {
  McpInputSchema,
  McpToolDescriptor,
  McpTextContent,
  McpCallToolResult,
  McpServerInfo,
  McpResourceDescriptor,
  McpResourceContent,
  McpPromptDescriptor,
  McpCapabilities,
  McpInitializeResult,
} from '../ports/mcp/mcpProtocolTypes.ts';

import {
  type McpCallToolResult,
  type McpInitializeResult,
  type McpServerInfo,
  type McpTextContent,
} from '../ports/mcp/mcpProtocolTypes.ts';

/**
 * @beta
 * MCP 协议常量与消息构造（无第三方依赖，JSON-RPC 2.0 承载）。
 *
 * 协议常量（版本号 / 方法名 / 错误码）保持 `static readonly` 命名空间；
 * 纯构造逻辑以实例方法暴露，由组合根单例 `mcpProtocol` 统一装配。
 */
export class McpProtocol {
  /** 支持的协议版本（2025-06-18：当前稳定版，与主流 MCP 客户端互操作）。 */
  public static readonly PROTOCOL_VERSION = '2025-06-18';
  /** 最新无状态修订（2026-07-28，INT-01/02）：双栈中的 v2 版本锚。 */
  public static readonly PROTOCOL_VERSION_V2 = '2026-07-28';
  /** 方法名：服务端能力发现（v2 无状态握手替代 initialize）。 */
  public static readonly METHOD_SERVER_DISCOVER = 'server/discover';
  /** 方法名：握手。 */
  public static readonly METHOD_INITIALIZE = 'initialize';
  /** 方法名：列举工具。 */
  public static readonly METHOD_TOOLS_LIST = 'tools/list';
  /** 方法名：调用工具。 */
  public static readonly METHOD_TOOLS_CALL = 'tools/call';
  /** 通知名：服务端工具列表变化（2026-10-21；客户端据此刷新注册）。 */
  public static readonly NOTIFICATION_TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';
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
