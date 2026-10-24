import type { ToolContext, ToolPort } from '../tool/tool.ts';
import type { Transport } from '../server/transport.ts';
import type {
  McpServerInfo,
  McpResourceDescriptor,
  McpResourceContent,
  McpPromptDescriptor,
  McpResourceTemplate,
} from '../mcp/mcpProtocolTypes.ts';
import type { ToolGatePort } from '../runtime/toolGatePort.ts';
import type { McpInputRequiredPort } from './mcpInputRequiredPort.ts';

/**
 * @beta
 * 资源后端端口：MCP 服务端以此把宿主资源（文件、文档、KV 等）暴露为 resources/list + resources/read。
 * 可选；未注入时服务端对 resources/* 返回空列表（符合协议，不伪造数据）。
 */
export interface ResourcePort {
  readonly name: string;
  list(): Promise<readonly McpResourceDescriptor[]>;
  read(uri: string): Promise<McpResourceContent>;
  /**
   * 可选：资源模板（`resources/templates/list`，2026-07-28 的 CacheableResult 方法之一）。
   * 未实现时服务端返回空模板列表（不伪造）。
   * @returns 模板描述列表。
   */
  templates?(): Promise<readonly McpResourceTemplate[]>;
}

/**
 * @beta
 * 提示模板后端端口：暴露 prompts/list + prompts/get。
 */
export interface PromptPort {
  readonly name: string;
  list(): Promise<readonly McpPromptDescriptor[]>;
  get(name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * @beta
 * 可缓存结果的 TTL/缓存范围配置（2026-07-28 CacheableResult）。
 *
 * 默认值刻意保守：列表类 60s、`resources/read` 30s、`server/discover` 5min；
 * 全部为 `private`（MCP 内容通常随授权上下文变化，默认不跨授权上下文共享）。
 */
export interface McpCacheOptions {
  /** 未按方法覆盖时的 TTL（毫秒，默认 60000）。 */
  readonly ttlMs?: number | undefined;
  /** 未按方法覆盖时的缓存范围（默认 `private`）。 */
  readonly cacheScope?: 'public' | 'private' | undefined;
  /** 按方法覆盖：键为 MCP 方法名（如 `tools/list`）。 */
  readonly perMethod?: Readonly<
    Record<
      string,
      {
        readonly ttlMs?: number | undefined;
        readonly cacheScope?: 'public' | 'private' | undefined;
      }
    >
  >;
}

/**
 * @beta
 * MCP 服务端选项。
 *
 * `gate` 引用 ports 层 `ToolGatePort`（审批 + 沙箱）；2026-07-28 的 MRTR 由独立的
 * {@link McpInputRequiredPort} 表达——它是「需要人机输入」的 live handler，先于门禁评估，
 * 以便审批/`ask_user` 型工具走 `input_required` 往返而不是直接拒绝。
 */
export interface McpServerOptions {
  readonly transport: Transport;
  readonly tools: ToolPort;
  readonly context: ToolContext;
  readonly serverInfo?: McpServerInfo | undefined;
  /** 可选门禁：注入后外部 MCP 调用同样过审批 + 沙箱。 */
  readonly gate?: ToolGatePort | undefined;
  /** 可选资源后端：注入后服务端应答 resources/*。 */
  readonly resources?: ResourcePort | undefined;
  /** 可选提示模板后端：注入后服务端应答 prompts/*。 */
  readonly prompts?: PromptPort | undefined;
  /** 可缓存结果的 TTL/范围（缺省保守默认值）。 */
  readonly cache?: McpCacheOptions | undefined;
  /** 官方扩展协商位（缺省空对象；只声明真正实现的扩展）。 */
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  /** MRTR live handler（缺省不产生 `input_required`，行为与旧版一致）。 */
  readonly inputRequired?: McpInputRequiredPort | undefined;
  /**
   * `requestState` 的 HMAC 密钥（缺省每次进程启动随机生成）。
   *
   * 多实例部署时必须显式给同一个密钥，否则实例 A 密封的状态在实例 B 验签失败
   * （fail-closed，会拒绝重试——符合安全预期，但功能不可用）。
   */
  readonly requestStateSecret?: string | undefined;
  /** `requestState` 有效期（毫秒，默认 5 分钟）。 */
  readonly requestStateTtlMs?: number | undefined;
  /** 并发订阅上限（默认 64；超限 fail-closed，拒绝新 listen）。 */
  readonly maxSubscriptions?: number | undefined;
  /** 是否在结果 `_meta` 中回传 OTel trace 上下文（默认 true）。 */
  readonly tracePropagation?: boolean | undefined;
}
