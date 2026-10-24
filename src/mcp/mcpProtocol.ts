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
  McpClientCapabilities,
  McpCacheableResult,
  McpResourceTemplate,
  McpInputRequestSpec,
  McpInputRequests,
  McpInputResponses,
  McpInputRequiredResult,
  McpSubscriptionFilter,
} from '../ports/mcp/mcpProtocolTypes.ts';

import {
  type McpCacheableResult,
  type McpCallToolResult,
  type McpCapabilities,
  type McpInitializeResult,
  type McpServerInfo,
  type McpTextContent,
} from '../ports/mcp/mcpProtocolTypes.ts';

/**
 * @beta
 * MCP 协议常量与消息构造（无第三方依赖，JSON-RPC 2.0 承载）。
 *
 * 协议常量（版本号 / 方法名 / 错误码 / `_meta` 键）保持 `static readonly` 命名空间；
 * 纯构造逻辑以实例方法暴露，由组合根单例 `mcpProtocol` 统一装配。
 */
export class McpProtocol {
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

  /**
   * 构造 initialize 结果（legacy 握手；能力与 v2 共用同一份声明）。
   * @param serverInfo 服务端信息。
   * @param capabilities 能力声明（缺省 tools/resources/prompts 空能力）。
   * @returns initialize 结果。
   */
  public initializeResult(
    serverInfo: McpServerInfo,
    capabilities: McpCapabilities = { tools: {}, resources: {}, prompts: {} },
  ): McpInitializeResult {
    return {
      protocolVersion: McpProtocol.PROTOCOL_VERSION,
      capabilities,
      serverInfo,
    };
  }

  /**
   * 构造 2026-07-28 `server/discover` 结果（无 initialize 握手）。
   *
   * `DiscoverResult extends CacheableResult`：缓存字段由调用方（服务端 cache 策略）给出；
   * 缺省也补一份保守值，保证单独调用本构造器时仍是合法结果。
   * @param serverInfo 服务端信息。
   * @param options 能力/版本/说明/扩展/缓存（均可缺省）。
   * @returns 发现结果。
   */
  public discoverResult(
    serverInfo: McpServerInfo,
    options: {
      readonly capabilities?: McpCapabilities | undefined;
      readonly supportedVersions?: readonly string[] | undefined;
      readonly instructions?: string | undefined;
      readonly cache?: McpCacheableResult | undefined;
    } = {},
  ): Record<string, unknown> {
    return {
      resultType: 'complete',
      supportedVersions: [...(options.supportedVersions ?? McpProtocol.SUPPORTED_VERSIONS)],
      capabilities: options.capabilities ?? { tools: {}, resources: {}, prompts: {} },
      ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
      ttlMs: options.cache?.ttlMs ?? 300_000,
      cacheScope: options.cache?.cacheScope ?? 'public',
      _meta: { [McpProtocol.META_SERVER_INFO]: serverInfo },
    };
  }
}

/**
 * 协议常量命名空间（与类声明合并；调用点仍写 `McpProtocol.XXX`）。
 *
 * 2026-10-24：从类静态字段迁到 namespace，避免「常量数量」把 McpProtocol 误判为上帝类；
 * 语义与访问方式不变。
 */
export namespace McpProtocol {
  /** 支持的协议版本（2025-06-18：legacy 握手栈，用于双栈兼容）。 */
  export const PROTOCOL_VERSION = '2025-06-18';
  /** 最新无状态修订（2026-07-28，INT-01/02）：双栈中的 v2 版本锚。 */
  export const PROTOCOL_VERSION_V2 = '2026-07-28';
  /** 本服务端实际支持的全部版本（含 legacy）。 */
  export const SUPPORTED_VERSIONS: readonly string[] = [PROTOCOL_VERSION_V2, PROTOCOL_VERSION];
  /** 方法名：服务端能力发现（v2 无状态握手替代 initialize）。 */
  export const METHOD_SERVER_DISCOVER = 'server/discover';
  /** 方法名：握手（legacy；现代请求不调用）。 */
  export const METHOD_INITIALIZE = 'initialize';
  /** 方法名：列举工具。 */
  export const METHOD_TOOLS_LIST = 'tools/list';
  /** 方法名：调用工具。 */
  export const METHOD_TOOLS_CALL = 'tools/call';
  /** 通知名：服务端工具列表变化（客户端据此刷新注册）。 */
  export const NOTIFICATION_TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';
  /** 通知名：提示模板列表变化（2026-07-28 subscriptions/listen 过滤项）。 */
  export const NOTIFICATION_PROMPTS_LIST_CHANGED = 'notifications/prompts/list_changed';
  /** 通知名：资源列表变化（2026-07-28 subscriptions/listen 过滤项）。 */
  export const NOTIFICATION_RESOURCES_LIST_CHANGED = 'notifications/resources/list_changed';
  /** 通知名：单个资源内容更新（订阅 `resourceSubscriptions` 后）。 */
  export const NOTIFICATION_RESOURCES_UPDATED = 'notifications/resources/updated';
  /** 通知名：订阅建立确认（必须是该订阅流上的第一条消息）。 */
  export const NOTIFICATION_SUBSCRIPTIONS_ACKNOWLEDGED = 'notifications/subscriptions/acknowledged';
  /** 通知名：请求取消（客户端可用来结束 subscriptions/listen）。 */
  export const NOTIFICATION_CANCELLED = 'notifications/cancelled';
  /** 方法名：列举资源。 */
  export const METHOD_RESOURCES_LIST = 'resources/list';
  /** 方法名：读取资源。 */
  export const METHOD_RESOURCES_READ = 'resources/read';
  /** 方法名：列举资源模板（2026-07-28 可缓存方法）。 */
  export const METHOD_RESOURCES_TEMPLATES_LIST = 'resources/templates/list';
  /** 方法名：列举提示模板。 */
  export const METHOD_PROMPTS_LIST = 'prompts/list';
  /** 方法名：获取提示模板。 */
  export const METHOD_PROMPTS_GET = 'prompts/get';
  /** 方法名：打开长生命周期订阅流。 */
  export const METHOD_SUBSCRIPTIONS_LISTEN = 'subscriptions/listen';
  /** 方法名：心跳（2026-07-28 已移除；仅 legacy 请求应答）。 */
  export const METHOD_PING = 'ping';
  /** `_meta` 键：每请求协议版本。 */
  export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
  /** `_meta` 键：每请求客户端信息。 */
  export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
  /** `_meta` 键：每请求客户端能力。 */
  export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
  /** `_meta` 键：结果中的服务端信息。 */
  export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
  /** `_meta` 键：订阅关联 id（通知与优雅关闭响应都带）。 */
  export const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';
  /** `_meta` 键：OTel trace 上下文（W3C Trace Context）。 */
  export const META_TRACEPARENT = 'traceparent';
  /** `_meta` 键：OTel tracestate。 */
  export const META_TRACESTATE = 'tracestate';
  /** `_meta` 键：OTel baggage。 */
  export const META_BAGGAGE = 'baggage';
  /** 错误码：方法不存在。 */
  export const ERROR_METHOD_NOT_FOUND = -32601;
  /** 错误码：参数无效（2026-07-28 起也用于「资源不存在」，替代 -32002）。 */
  export const ERROR_INVALID_PARAMS = -32602;
  /** 错误码：内部错误。 */
  export const ERROR_INTERNAL = -32603;
  /** 错误码：协议版本不受支持（2026-07-28，UnsupportedProtocolVersionError）。 */
  export const ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
  /** 错误码：缺少必需的客户端能力（2026-07-28，MissingRequiredClientCapabilityError）。 */
  export const ERROR_MISSING_CLIENT_CAPABILITY = -32021;
  /** 错误码：请求头/体内不一致（2026-07-28，HeaderMismatchError）。 */
  export const ERROR_HEADER_MISMATCH = -32020;
  /** 可缓存方法集合（2026-07-28 CacheableResult 要求）。 */
  export const CACHEABLE_METHODS: readonly string[] = [
    METHOD_SERVER_DISCOVER,
    METHOD_TOOLS_LIST,
    METHOD_PROMPTS_LIST,
    METHOD_RESOURCES_LIST,
    METHOD_RESOURCES_READ,
    METHOD_RESOURCES_TEMPLATES_LIST,
  ];
}

/** 组合根单例：纯构造逻辑的统一装配点。协议常量仍经 `McpProtocol.XXX` 访问。 */
export const mcpProtocol = new McpProtocol();
