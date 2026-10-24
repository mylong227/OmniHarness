/**
 * MCP 2026-07-28 每请求 `_meta` 的解析与校验（stateless：不依赖任何连接状态）。
 *
 * 规则（规范 basic/index#meta + versioning）：
 *  - `_meta["io.modelcontextprotocol/protocolVersion"]` 必需；不支持时返回 `-32022`；
 *  - `_meta["io.modelcontextprotocol/clientCapabilities"]` 必需；
 *  - `clientInfo` 可选（仅展示/诊断，不用于安全决策）；
 *  - 完全没有 `_meta` 的请求按 **legacy**（2025-06-18 握手栈）处理，保留旧 stdio 兼容。
 */
import type { McpClientCapabilities, McpServerInfo } from '../ports/mcp/mcpProtocolTypes.ts';
import { McpProtocol } from './mcpProtocol.ts';
import { McpError } from './mcpError.ts';
import { McpTraceContext, type McpTraceCarrier } from './mcpTraceContext.ts';

/** 解析后的请求上下文。 */
export interface ParsedMcpRequestContext {
  /** 是否现代（2026-07-28）请求。 */
  readonly modern: boolean;
  /** 请求声明的协议版本（legacy 时 undefined）。 */
  readonly protocolVersion?: string | undefined;
  /** 自报客户端信息（不用于安全决策）。 */
  readonly clientInfo?: McpServerInfo | undefined;
  /** 客户端能力（legacy 时为空对象）。 */
  readonly clientCapabilities: McpClientCapabilities;
  /** trace 载体（`_meta` 带 traceparent 时）。 */
  readonly trace?: McpTraceCarrier | undefined;
}

/**
 * `_meta` 解析器。
 */
export class McpRequestContext {
  /**
   * 解析请求参数。
   * @param params JSON-RPC `params`（缺省空对象）。
   * @returns 请求上下文。
   * @throws {@link McpError} `-32602`（缺必需字段/形状非法）或 `-32022`（版本不支持）。
   */
  public static parse(params: Record<string, unknown>): ParsedMcpRequestContext {
    const rawMeta = params['_meta'];
    if (rawMeta === undefined) {
      return { modern: false, clientCapabilities: {} };
    }
    if (typeof rawMeta !== 'object' || rawMeta === null || Array.isArray(rawMeta)) {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, '请求 _meta 必须是对象');
    }
    const meta = rawMeta as Record<string, unknown>;
    const version = meta[McpProtocol.META_PROTOCOL_VERSION];
    if (version === undefined || version === null) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        `请求 _meta 缺少必需字段 ${McpProtocol.META_PROTOCOL_VERSION}`,
      );
    }
    if (typeof version !== 'string' || version.trim() === '') {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, '协议版本必须是非空字符串');
    }
    if (!McpProtocol.SUPPORTED_VERSIONS.includes(version)) {
      throw new McpError(McpProtocol.ERROR_UNSUPPORTED_PROTOCOL_VERSION, '不支持的协议版本', {
        supported: [...McpProtocol.SUPPORTED_VERSIONS],
        requested: version,
      });
    }
    const capabilities = meta[McpProtocol.META_CLIENT_CAPABILITIES];
    if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        `请求 _meta 缺少必需字段 ${McpProtocol.META_CLIENT_CAPABILITIES}`,
      );
    }
    const rawInfo = meta[McpProtocol.META_CLIENT_INFO];
    const clientInfo =
      typeof rawInfo === 'object' &&
      rawInfo !== null &&
      typeof (rawInfo as Record<string, unknown>)['name'] === 'string' &&
      typeof (rawInfo as Record<string, unknown>)['version'] === 'string'
        ? {
            name: (rawInfo as Record<string, unknown>)['name'] as string,
            version: (rawInfo as Record<string, unknown>)['version'] as string,
          }
        : undefined;
    const trace = McpTraceContext.parse(meta);
    return {
      modern: true,
      protocolVersion: version,
      ...(clientInfo !== undefined ? { clientInfo } : {}),
      clientCapabilities: capabilities as McpClientCapabilities,
      ...(trace !== undefined ? { trace } : {}),
    };
  }
}
