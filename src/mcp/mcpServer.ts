import type { McpCacheableResult, McpServerInfo } from '../ports/mcp/mcpProtocolTypes.ts';
import type { McpServerOptions } from '../ports/mcp/mcpServerOptions.ts';
import {
  jsonRpc,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from '../server/core/jsonRpc.ts';
import { log } from '../util/logger.ts';
import { McpCachePolicy } from './mcpCachePolicy.ts';
import { McpError } from './mcpError.ts';
import { McpMethodService } from './mcpMethodService.ts';
import { McpProtocol } from './mcpProtocol.ts';
import { McpRequestContext, type ParsedMcpRequestContext } from './mcpRequestContext.ts';
import { McpSecretGuard } from './mcpSecretGuard.ts';
import { McpSubscriptionService } from './mcpSubscriptionService.ts';
import type { McpSubscriptionEvent } from './mcpSubscriptionHub.ts';
import { McpTraceContext } from './mcpTraceContext.ts';

/** 错误响应载荷。 */
interface McpErrorPayload {
  /** JSON-RPC 错误码。 */
  readonly code: number;
  /** 脱敏后的错误消息。 */
  readonly message: string;
  /** 结构化附加信息。 */
  readonly data?: unknown;
}

/** 结果装饰依赖（缓存策略 / 服务端信息 / trace 传播开关）。 */
interface McpDecorationDeps {
  /** 可缓存结果策略。 */
  readonly cache: McpCachePolicy;
  /** 对外上报的服务端信息。 */
  readonly serverInfo: McpServerInfo;
  /** 是否回传 trace 上下文。 */
  readonly tracePropagation: boolean;
}

/**
 * 结果装饰：`resultType` + `_meta.serverInfo` + 缓存字段 + trace 子 span。
 * @param method 方法名。
 * @param result 处理器结果。
 * @param context 请求上下文。
 * @param deps 装饰依赖。
 * @returns 装饰后的结果。
 */
const decorateResult = (
  method: string,
  result: unknown,
  context: ParsedMcpRequestContext,
  deps: McpDecorationDeps,
): unknown => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const record: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  if (record['resultType'] === undefined) record['resultType'] = 'complete';
  if (record['resultType'] === 'complete' && deps.cache.isCacheable(method)) {
    const fields: McpCacheableResult = deps.cache.fieldsFor(method);
    if (record['ttlMs'] === undefined) record['ttlMs'] = fields.ttlMs;
    if (record['cacheScope'] === undefined) record['cacheScope'] = fields.cacheScope;
  }
  const meta =
    typeof record['_meta'] === 'object' && record['_meta'] !== null
      ? { ...(record['_meta'] as Record<string, unknown>) }
      : {};
  meta[McpProtocol.META_SERVER_INFO] = deps.serverInfo;
  const carrier = deps.tracePropagation ? context.trace : undefined;
  const trace = carrier === undefined ? undefined : McpTraceContext.child(carrier);
  record['_meta'] = trace === undefined ? meta : McpTraceContext.inject(meta, trace);
  return record;
};

/** 提取错误消息。 */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 异常 → 错误载荷（`McpError` 保留码/data；其余收敛为 `-32602`）。
 * @param error 异常。
 * @returns 错误载荷。
 */
const errorPayloadOf = (error: unknown): McpErrorPayload => {
  if (error instanceof McpError) {
    return {
      code: error.code,
      message: McpSecretGuard.redact(error.message),
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  return {
    code: McpProtocol.ERROR_INVALID_PARAMS,
    message: McpSecretGuard.redact(messageOf(error)),
  };
};

/**
 * @beta
 * MCP 服务端：把 OmniHarness 工具集暴露给任意 MCP 客户端。
 *
 * 2026-07-28 双栈实现（legacy 握手栈 + 现代无状态栈共存）：
 *  - 每个请求的 `_meta` 携带协议版本 / 客户端能力 / 客户端信息，服务端逐请求校验版本；
 *  - 每个结果带 `resultType` 与 `_meta.serverInfo`；可缓存方法带 `ttlMs`/`cacheScope`；
 *  - `server/discover`、`subscriptions/listen`（长生命周期流）、MRTR `input_required`；
 *  - `extensions` 能力协商位；OTel trace 上下文在 `_meta` 中传播。
 *
 * 没有 `_meta` 的请求按 legacy 处理（保留旧 stdio 客户端行为）。
 *
 * 本类只保留「消息入口 + `_meta` 解析 + 结果/错误装饰」这一层薄壳：
 *  - 订阅生命周期与通知发布 → {@link McpSubscriptionService}；
 *  - MRTR 裁决与 `requestState` 编解码 → {@link McpInputRequiredService}（由方法服务持有）；
 *  - 方法注册与业务处理器 → {@link McpMethodService}。
 */
export class McpServer {
  /** 对外上报的服务端信息。 */
  private readonly serverInfo: McpServerInfo;
  /** 可缓存结果策略。 */
  private readonly cache: McpCachePolicy;
  /** 请求方法表与业务处理器。 */
  private readonly methods: McpMethodService;
  /** 订阅服务（listen / publish / 关闭）。 */
  private readonly subscriptions: McpSubscriptionService;

  /**
   * @param options 传输、工具集、门禁、资源/提示后端、缓存与 MRTR live handler。
   */
  public constructor(private readonly options: McpServerOptions) {
    this.serverInfo = options.serverInfo ?? { name: 'omniharness', version: '0.1.0' };
    this.cache = new McpCachePolicy(options.cache);
    this.subscriptions = new McpSubscriptionService(
      options.transport,
      options.maxSubscriptions ?? 64,
    );
    this.methods = new McpMethodService(options, this.serverInfo, this.cache);
    options.transport.onMessage((message) => void this.handle(message));
  }

  /**
   * 处理入站消息：请求走分发，通知只处理 `notifications/cancelled`。
   * @param message 入站 JSON-RPC 消息。
   * @returns 无返回值。
   */
  public async handle(message: RpcMessage): Promise<void> {
    if (jsonRpc.isRequest(message)) {
      await this.handleRequest(message);
      return;
    }
    if (jsonRpc.isCall(message)) {
      this.handleNotification(message as RpcNotification);
    }
  }

  /**
   * 优雅关闭全部订阅（先发完成响应再关流）。幂等。
   * @returns 无返回值。
   */
  public close(): void {
    this.subscriptions.closeAll();
  }

  /**
   * 发布「工具列表变化」到匹配的订阅。
   * @returns 实际发送的通知条数。
   */
  public notifyToolsChanged(): number {
    return this.publish({ kind: 'toolsListChanged' });
  }

  /**
   * 发布「提示模板列表变化」到匹配的订阅。
   * @returns 实际发送的通知条数。
   */
  public notifyPromptsChanged(): number {
    return this.publish({ kind: 'promptsListChanged' });
  }

  /**
   * 发布「资源列表变化」到匹配的订阅。
   * @returns 实际发送的通知条数。
   */
  public notifyResourcesChanged(): number {
    return this.publish({ kind: 'resourcesListChanged' });
  }

  /**
   * 发布「某个资源更新」到订阅了该 URI 的订阅。
   * @param uri 资源 URI。
   * @returns 实际发送的通知条数。
   */
  public notifyResourceUpdated(uri: string): number {
    return this.publish({ kind: 'resourceUpdated', uri });
  }

  /**
   * 发布订阅事件（薄委托给订阅服务）。
   * @param event 事件。
   * @returns 实际发送的通知条数。
   */
  private publish(event: McpSubscriptionEvent): number {
    return this.subscriptions.publish(event);
  }

  /**
   * 列举工具（薄委托）。
   *
   * 保持 public 的原因：既有判据 `tests/unit/toolExposureRetrieval.test.ts` 直接调用
   * `server.listTools()`（拆分前它是同名的私有方法，运行时同样可达）；此处以薄委托保留该
   * 测试缝，工具排序/映射仍由 {@link McpMethodService} 实现。
   * @returns `{tools}`（按名字升序）。
   */
  public listTools(): unknown {
    return this.methods.listTools();
  }

  /**
   * 处理请求：解析 `_meta` → 在 trace 上下文中分发 → 装饰结果/错误。
   * @param request 请求。
   * @returns 无返回值。
   */
  private async handleRequest(request: RpcRequest): Promise<void> {
    let context: ParsedMcpRequestContext;
    try {
      context = McpRequestContext.parse(request.params ?? {});
    } catch (error) {
      this.replyError(request, error);
      return;
    }
    const traceId =
      context.trace === undefined ? undefined : McpTraceContext.traceIdOf(context.trace);
    await log.withTrace(traceId, () => this.dispatchAndReply(request, context));
  }

  /**
   * 分发给业务处理器并回复（`subscriptions/listen` 不回复）。
   * @param request 请求。
   * @param context 请求上下文。
   * @returns 无返回值。
   */
  private async dispatchAndReply(
    request: RpcRequest,
    context: ParsedMcpRequestContext,
  ): Promise<void> {
    try {
      if (request.method === McpProtocol.METHOD_SUBSCRIPTIONS_LISTEN) {
        this.subscriptions.listen(request.params ?? {}, context, request.id);
        return;
      }
      const result = await this.methods.dispatch(request.method, request.params ?? {}, context);
      this.options.transport.send(
        jsonRpc.response(
          request.id,
          decorateResult(request.method, result, context, {
            cache: this.cache,
            serverInfo: this.serverInfo,
            tracePropagation: this.options.tracePropagation !== false,
          }),
        ),
      );
    } catch (error) {
      this.replyError(request, error);
    }
  }

  /**
   * 处理通知：只认 `notifications/cancelled`（用于结束订阅）。
   * @param message 通知。
   * @returns 无返回值。
   */
  private handleNotification(message: RpcNotification): void {
    if (message.method !== McpProtocol.NOTIFICATION_CANCELLED) return;
    this.subscriptions.cancel((message.params ?? {})['requestId']);
  }

  /**
   * 回复错误（错误消息先脱敏）。
   * @param request 请求。
   * @param error 异常。
   * @returns 无返回值。
   */
  private replyError(request: RpcRequest, error: unknown): void {
    const payload = errorPayloadOf(error);
    const response: RpcResponse = {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: payload.code,
        message: payload.message,
        ...(payload.data !== undefined ? { data: payload.data } : {}),
      },
    };
    log.warn('mcp.request.failed', { method: request.method, code: payload.code });
    this.options.transport.send(response);
  }
}

// `McpServerOptions` / `ResourcePort` / `PromptPort` 的契约已外迁至 `ports/mcp/mcpServerOptions.ts`，
// 此处仅再导出以维持既有公共 API 面（`index.ts`、`mcpServeRunner.ts`、`mcp.test.ts` 等调用点零改动）。
export type { McpServerOptions, ResourcePort, PromptPort } from '../ports/mcp/mcpServerOptions.ts';
