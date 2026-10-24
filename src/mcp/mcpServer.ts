import { randomBytes } from 'node:crypto';
import type { ToolCall } from '../ports/tool/tool.ts';
import type { McpServerOptions } from '../ports/mcp/mcpServerOptions.ts';
import type {
  McpCacheableResult,
  McpCapabilities,
  McpInputResponses,
  McpServerInfo,
  McpSubscriptionFilter,
} from '../ports/mcp/mcpProtocolTypes.ts';
import type { McpInputRequiredDecision } from '../ports/mcp/mcpInputRequiredPort.ts';
import type { SubscriptionChannel } from '../ports/server/subscriptionChannel.ts';
import { Id } from '../util/id.ts';
import {
  jsonRpc,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from '../server/core/jsonRpc.ts';
import { log } from '../util/logger.ts';
import { McpCachePolicy } from './mcpCachePolicy.ts';
import { McpClientCapabilitiesGuard } from './mcpClientCapabilitiesGuard.ts';
import { McpError } from './mcpError.ts';
import { McpProtocol, mcpProtocol } from './mcpProtocol.ts';
import { McpRequestContext, type ParsedMcpRequestContext } from './mcpRequestContext.ts';
import { McpRequestStateCodec } from './mcpRequestStateCodec.ts';
import { McpSecretGuard } from './mcpSecretGuard.ts';
import { McpSubscriptionHub, type McpSubscriptionEvent } from './mcpSubscriptionHub.ts';
import { McpTraceContext } from './mcpTraceContext.ts';
import { mcpToolMapper } from './mcpToolMapper.ts';

/** 错误响应载荷。 */
interface McpErrorPayload {
  /** JSON-RPC 错误码。 */
  readonly code: number;
  /** 脱敏后的错误消息。 */
  readonly message: string;
  /** 结构化附加信息。 */
  readonly data?: unknown;
}

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
 */
export class McpServer {
  /** 已注册方法（只含请求方法；通知单独处理）。 */
  private readonly handlers = new Map<
    string,
    (params: Record<string, unknown>, context: ParsedMcpRequestContext) => Promise<unknown>
  >();
  /** 对外上报的服务端信息。 */
  private readonly serverInfo: McpServerInfo;
  /** 可缓存结果策略。 */
  private readonly cache: McpCachePolicy;
  /** 订阅中枢。 */
  private readonly subscriptions: McpSubscriptionHub;
  /** `requestState` 编解码器（HMAC）。 */
  private readonly requestState: McpRequestStateCodec;
  /** 是否回传 trace 上下文。 */
  private readonly tracePropagation: boolean;

  /**
   * @param options 传输、工具集、门禁、资源/提示后端、缓存与 MRTR live handler。
   */
  public constructor(private readonly options: McpServerOptions) {
    this.serverInfo = options.serverInfo ?? { name: 'omniharness', version: '0.1.0' };
    this.cache = new McpCachePolicy(options.cache);
    this.subscriptions = new McpSubscriptionHub(options.maxSubscriptions ?? 64);
    this.requestState = new McpRequestStateCodec(
      options.requestStateSecret ??
        process.env['OMNI_MCP_REQUEST_STATE_SECRET'] ??
        randomBytes(32).toString('hex'),
      options.requestStateTtlMs ?? McpRequestStateCodec.DEFAULT_TTL_MS,
    );
    this.tracePropagation = options.tracePropagation !== false;
    this.registerHandlers();
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
   * 发布订阅事件。
   * @param event 事件。
   * @returns 实际发送的通知条数。
   */
  private publish(event: McpSubscriptionEvent): number {
    return this.subscriptions.publish(event);
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
        await this.listen(request.params ?? {}, context, request.id);
        return;
      }
      const result = await this.dispatch(request.method, request.params ?? {}, context);
      this.options.transport.send(
        jsonRpc.response(request.id, this.decorate(request.method, result, context)),
      );
    } catch (error) {
      this.replyError(request, error);
    }
  }

  /**
   * 按方法名分发（未知方法 → `-32601`）。
   * @param method 方法名。
   * @param params 参数。
   * @param context 请求上下文。
   * @returns 处理器结果或 `NO_RESPONSE`。
   */
  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    context: ParsedMcpRequestContext,
  ): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      throw new McpError(McpProtocol.ERROR_METHOD_NOT_FOUND, `方法不存在: ${method}`);
    }
    return await handler(params, context);
  }

  /**
   * 注册请求方法。
   * @returns 无返回值。
   */
  private registerHandlers(): void {
    this.handlers.set(McpProtocol.METHOD_INITIALIZE, async () => this.initialize());
    this.handlers.set(McpProtocol.METHOD_SERVER_DISCOVER, async () => this.discover());
    this.handlers.set(McpProtocol.METHOD_PING, async (_params, context) => this.ping(context));
    this.handlers.set(McpProtocol.METHOD_TOOLS_LIST, async () => this.listTools());
    this.handlers.set(McpProtocol.METHOD_TOOLS_CALL, (params, context) =>
      this.callTool(params, context),
    );
    this.handlers.set(McpProtocol.METHOD_RESOURCES_LIST, async () => this.listResources());
    this.handlers.set(McpProtocol.METHOD_RESOURCES_READ, (params) => this.readResource(params));
    this.handlers.set(McpProtocol.METHOD_RESOURCES_TEMPLATES_LIST, async () =>
      this.listResourceTemplates(),
    );
    this.handlers.set(McpProtocol.METHOD_PROMPTS_LIST, async () => this.listPrompts());
    this.handlers.set(McpProtocol.METHOD_PROMPTS_GET, (params) => this.getPrompt(params));
  }

  /**
   * legacy 握手：返回协议版本与能力声明。
   * @returns initialize 结果。
   */
  private initialize(): unknown {
    return mcpProtocol.initializeResult(this.serverInfo, this.capabilities());
  }

  /**
   * 2026-07-28 无状态发现（不要求 initialize 握手）。
   * @returns DiscoverResult（含缓存字段）。
   */
  private discover(): unknown {
    return mcpProtocol.discoverResult(this.serverInfo, {
      capabilities: this.capabilities(),
      supportedVersions: McpProtocol.SUPPORTED_VERSIONS,
      cache: this.cache.fieldsFor(McpProtocol.METHOD_SERVER_DISCOVER),
    });
  }

  /**
   * 服务端能力：三类 listChanged、资源订阅、扩展协商位。
   * @returns 能力声明。
   */
  private capabilities(): McpCapabilities {
    return {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      extensions: { ...(this.options.extensions ?? {}) },
    };
  }

  /**
   * 心跳：2026-07-28 已移除，仅 legacy 请求应答。
   * @param context 请求上下文。
   * @returns 空结果。
   */
  private ping(context: ParsedMcpRequestContext): unknown {
    if (context.modern) {
      throw new McpError(McpProtocol.ERROR_METHOD_NOT_FOUND, '2026-07-28 已移除 ping');
    }
    return {};
  }

  /**
   * 列举工具（确定性排序：名字升序，作为 prompt 前缀缓存的一部分）。
   * @returns `{tools}`。
   */
  private listTools(): unknown {
    return {
      tools: [...this.options.tools.list()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((definition) => mcpToolMapper.toDescriptor(definition)),
    };
  }

  /**
   * 调用工具：MRTR live handler → 门禁 → 执行。
   * @param params 调用参数。
   * @param context 请求上下文。
   * @returns MCP 工具结果或 `input_required` 中间结果。
   */
  private async callTool(
    params: Record<string, unknown>,
    context: ParsedMcpRequestContext,
  ): Promise<unknown> {
    const name = params['name'];
    if (typeof name !== 'string' || name === '') {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, 'tools/call 缺少 name');
    }
    const call: ToolCall = { id: Id.id('mcp'), name, arguments: this.argumentsOf(params) };
    const decision = await this.inputDecisionOf(call, params, context);
    switch (decision.kind) {
      case 'allow':
        return await this.execute(call);
      case 'deny':
        return mcpProtocol.toolResult(undefined, decision.message);
      case 'respond':
        return decision.isError === true
          ? mcpProtocol.toolResult(decision.output, decision.output)
          : mcpProtocol.toolResult(decision.output, undefined);
      case 'input_required':
        return this.inputRequiredResult(decision, call);
    }
  }

  /**
   * 执行工具（过门禁后调 ToolPort）。
   * @param call 工具调用。
   * @returns MCP 工具结果。
   */
  private async execute(call: ToolCall): Promise<unknown> {
    const denied = await this.gateOf(call);
    if (denied !== undefined) {
      return mcpProtocol.toolResult(denied.output, denied.error);
    }
    const result = await this.options.tools.execute(call, this.options.context);
    return mcpProtocol.toolResult(result.output, result.error);
  }

  /**
   * 评估 MRTR：验签 `requestState` → 调 live handler。
   * @param call 工具调用。
   * @param params 请求参数。
   * @param context 请求上下文。
   * @returns 裁决（input_required 时能力已校验）。
   */
  private async inputDecisionOf(
    call: ToolCall,
    params: Record<string, unknown>,
    context: ParsedMcpRequestContext,
  ): Promise<McpInputRequiredDecision> {
    const port = this.options.inputRequired;
    if (port === undefined) return { kind: 'allow' };
    const digest = this.stateDigestOf(call);
    const stateRaw = params['requestState'];
    let attempt = 0;
    let responses: McpInputResponses | undefined;
    let state: Readonly<Record<string, unknown>> | undefined;
    if (stateRaw !== undefined) {
      if (typeof stateRaw !== 'string') {
        throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, 'requestState 必须是字符串');
      }
      const opened = this.requestState.open(stateRaw, McpProtocol.METHOD_TOOLS_CALL, digest);
      if (!opened.ok) throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, opened.reason);
      attempt = 1;
      responses = this.inputResponsesOf(params['inputResponses']);
      state = this.recordOf(opened.data);
    } else if (params['inputResponses'] !== undefined) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        '重试携带 inputResponses 但缺少 requestState（fail-closed）',
      );
    }
    const decision = await port.evaluate({
      call,
      sessionId: this.options.context.sessionId,
      attempt,
      clientCapabilities: context.clientCapabilities,
      modern: context.modern,
      ...(responses !== undefined ? { inputResponses: responses } : {}),
      ...(state !== undefined ? { state } : {}),
    });
    if (decision.kind !== 'input_required') return decision;
    if (!context.modern) {
      return {
        kind: 'deny',
        message: 'MRTR input_required 需要 2026-07-28 每请求能力；legacy 客户端 fail-closed',
      };
    }
    McpClientCapabilitiesGuard.assertDeclared(decision.inputRequests, context.clientCapabilities);
    return decision;
  }

  /**
   * 构造 `input_required` 结果（密封 requestState）。
   * @param decision 裁决。
   * @param call 工具调用。
   * @returns MRTR 中间结果。
   */
  private inputRequiredResult(
    decision: Extract<McpInputRequiredDecision, { kind: 'input_required' }>,
    call: ToolCall,
  ): unknown {
    const digest = this.stateDigestOf(call);
    const requestState = this.requestState.seal(
      McpProtocol.METHOD_TOOLS_CALL,
      digest,
      decision.state ?? null,
    );
    if (decision.reason !== undefined) {
      log.debug('mcp.mrtr.input_required', { tool: call.name, reason: decision.reason });
    }
    return {
      resultType: 'input_required',
      inputRequests: decision.inputRequests,
      requestState,
      _meta: { [McpProtocol.META_SERVER_INFO]: this.serverInfo },
    };
  }

  /**
   * MRTR 状态绑定摘要（会话 + 方法参数；防跨会话/跨请求重用）。
   * @param call 工具调用。
   * @returns 稳定摘要。
   */
  private stateDigestOf(call: ToolCall): string {
    return McpRequestStateCodec.digestOf({
      sessionId: this.options.context.sessionId,
      name: call.name,
      arguments: call.arguments,
    });
  }

  /**
   * 解析 `inputResponses`（规范形状是对象映射；数组形态 fail-closed）。
   * @param raw 原始值。
   * @returns 回答映射。
   */
  private inputResponsesOf(raw: unknown): McpInputResponses {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        'inputResponses 必须是对象映射（键为 inputRequests 的 id）',
      );
    }
    return raw as McpInputResponses;
  }

  /**
   * 把未知值收敛为记录（非对象 → 空对象）。
   * @param value 原始值。
   * @returns 记录。
   */
  private recordOf(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  /**
   * 列举资源（未配置后端返回空列表，符合协议）。
   * @returns `{resources, nextCursor}`。
   */
  private async listResources(): Promise<unknown> {
    const items = this.options.resources === undefined ? [] : await this.options.resources.list();
    return { resources: items, nextCursor: null };
  }

  /**
   * 读取资源：后端 `{uri,text}` → 规范 `{contents:[…]}`。
   * @param params 参数。
   * @returns ReadResourceResult。
   */
  private async readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = params['uri'];
    if (typeof uri !== 'string' || uri === '') {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, 'resources/read 缺少 uri');
    }
    const backend = this.options.resources;
    if (backend === undefined) {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, '资源不存在或资源后端未配置');
    }
    const content = await backend.read(uri);
    return {
      contents: [
        {
          uri: content.uri,
          ...(content.mimeType !== undefined ? { mimeType: content.mimeType } : {}),
          text: content.text,
        },
      ],
    };
  }

  /**
   * 列举资源模板（未配置后端返回空列表）。
   * @returns `{resourceTemplates}`。
   */
  private async listResourceTemplates(): Promise<unknown> {
    const backend = this.options.resources;
    const templatesOf = backend?.templates;
    const templates = templatesOf === undefined ? [] : await templatesOf.call(backend);
    return { resourceTemplates: templates };
  }

  /**
   * 列举提示模板（未配置后端返回空列表）。
   * @returns `{prompts, nextCursor}`。
   */
  private async listPrompts(): Promise<unknown> {
    const items = this.options.prompts === undefined ? [] : await this.options.prompts.list();
    return { prompts: items, nextCursor: null };
  }

  /**
   * 获取提示模板（未配置后端报错）。
   * @param params 参数。
   * @returns `{description, messages}`。
   */
  private async getPrompt(params: Record<string, unknown>): Promise<unknown> {
    const name = params['name'];
    if (typeof name !== 'string' || name === '') {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, 'prompts/get 缺少 name');
    }
    const backend = this.options.prompts;
    if (backend === undefined) {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, '提示模板不存在或后端未配置');
    }
    const text = await backend.get(name, this.argumentsOf(params));
    return { description: name, messages: [{ role: 'user', content: { type: 'text', text } }] };
  }

  /**
   * 打开 `subscriptions/listen` 长生命周期流。
   * @param params 参数（`notifications` 过滤器）。
   * @param context 请求上下文。
   * @param requestId 请求 id（同时作为 subscriptionId）。
   * @returns 无返回值（不回 JSON-RPC 响应；ack 走订阅通道）。
   */
  private async listen(
    params: Record<string, unknown>,
    context: ParsedMcpRequestContext,
    requestId: number | string,
  ): Promise<void> {
    if (!context.modern) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        'subscriptions/listen 需要 2026-07-28 每请求 _meta',
      );
    }
    const filter = this.subscriptionFilterOf(params['notifications']);
    const channel = this.channelOf(requestId);
    try {
      this.subscriptions.register(requestId, filter, channel);
    } catch (error) {
      throw new McpError(McpProtocol.ERROR_INTERNAL, this.messageOf(error));
    }
  }

  /**
   * 为 listen 请求选通道：传输支持按请求分流则用它，否则回落共享通道。
   * @param id 请求 id。
   * @returns 订阅通道。
   */
  private channelOf(id: number | string): SubscriptionChannel {
    const split = this.options.transport.openSubscription?.(id);
    if (split !== undefined) return split;
    return {
      send: (message) => this.options.transport.send(message),
      close: () => undefined,
    };
  }

  /**
   * 规整 `notifications` 过滤参数。
   * @param raw 原始值。
   * @returns 过滤器（缺省空对象）。
   */
  private subscriptionFilterOf(raw: unknown): McpSubscriptionFilter {
    if (raw === undefined) return {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new McpError(McpProtocol.ERROR_INVALID_PARAMS, 'notifications 过滤器必须是对象');
    }
    const record = raw as Record<string, unknown>;
    const uris = record['resourceSubscriptions'];
    if (uris !== undefined && !Array.isArray(uris)) {
      throw new McpError(
        McpProtocol.ERROR_INVALID_PARAMS,
        'notifications.resourceSubscriptions 必须是字符串数组',
      );
    }
    return {
      ...(record['toolsListChanged'] === true ? { toolsListChanged: true } : {}),
      ...(record['promptsListChanged'] === true ? { promptsListChanged: true } : {}),
      ...(record['resourcesListChanged'] === true ? { resourcesListChanged: true } : {}),
      ...(Array.isArray(uris)
        ? {
            resourceSubscriptions: uris.filter(
              (uri): uri is string => typeof uri === 'string' && uri !== '',
            ),
          }
        : {}),
    };
  }

  /**
   * 处理通知：只认 `notifications/cancelled`（用于结束订阅）。
   * @param message 通知。
   * @returns 无返回值。
   */
  private handleNotification(message: RpcNotification): void {
    if (message.method !== McpProtocol.NOTIFICATION_CANCELLED) return;
    const params = message.params ?? {};
    const requestId = params['requestId'];
    if (typeof requestId === 'number' || typeof requestId === 'string') {
      this.subscriptions.close(requestId);
    }
  }

  /**
   * 门禁裁决（未注入门禁时直接放行，见原 JSDoc 的安全口径）。
   * @param call 工具调用。
   * @returns 拒绝结果；放行为 undefined。
   */
  private async gateOf(
    call: ToolCall,
  ): Promise<{ output?: string | undefined; error?: string | undefined } | undefined> {
    const gate = this.options.gate;
    if (gate === undefined) return undefined;
    return gate.gate(call, this.options.context.sessionId);
  }

  /**
   * 结果装饰：`resultType` + `_meta.serverInfo` + 缓存字段 + trace 子 span。
   * @param method 方法名。
   * @param result 处理器结果。
   * @param context 请求上下文。
   * @returns 装饰后的结果。
   */
  private decorate(method: string, result: unknown, context: ParsedMcpRequestContext): unknown {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
    const record: Record<string, unknown> = { ...(result as Record<string, unknown>) };
    if (record['resultType'] === undefined) record['resultType'] = 'complete';
    if (record['resultType'] === 'complete' && this.cache.isCacheable(method)) {
      const fields: McpCacheableResult = this.cache.fieldsFor(method);
      if (record['ttlMs'] === undefined) record['ttlMs'] = fields.ttlMs;
      if (record['cacheScope'] === undefined) record['cacheScope'] = fields.cacheScope;
    }
    const meta =
      typeof record['_meta'] === 'object' && record['_meta'] !== null
        ? { ...(record['_meta'] as Record<string, unknown>) }
        : {};
    meta[McpProtocol.META_SERVER_INFO] = this.serverInfo;
    const trace = this.resultTraceOf(context);
    record['_meta'] = trace === undefined ? meta : McpTraceContext.inject(meta, trace);
    return record;
  }

  /**
   * 计算结果 trace（请求带载体时派生同 trace 的子 span）。
   * @param context 请求上下文。
   * @returns 子载体；不传播/无载体时 undefined。
   */
  private resultTraceOf(context: ParsedMcpRequestContext) {
    if (!this.tracePropagation || context.trace === undefined) return undefined;
    return McpTraceContext.child(context.trace);
  }

  /**
   * 回复错误（错误消息先脱敏）。
   * @param request 请求。
   * @param error 异常。
   * @returns 无返回值。
   */
  private replyError(request: RpcRequest, error: unknown): void {
    const payload = this.errorPayloadOf(error);
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

  /**
   * 异常 → 错误载荷（`McpError` 保留码/data；其余收敛为 `-32602`）。
   * @param error 异常。
   * @returns 错误载荷。
   */
  private errorPayloadOf(error: unknown): McpErrorPayload {
    if (error instanceof McpError) {
      return {
        code: error.code,
        message: McpSecretGuard.redact(error.message),
        ...(error.data !== undefined ? { data: error.data } : {}),
      };
    }
    return {
      code: McpProtocol.ERROR_INVALID_PARAMS,
      message: McpSecretGuard.redact(this.messageOf(error)),
    };
  }

  /** 提取调用参数（非对象视为空参数）。 */
  private argumentsOf(params: Record<string, unknown>): Record<string, unknown> {
    const raw = params['arguments'];
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// `McpServerOptions` / `ResourcePort` / `PromptPort` 的契约已外迁至 `ports/mcp/mcpServerOptions.ts`，
// 此处仅再导出以维持既有公共 API 面（`index.ts`、`mcpServeRunner.ts`、`mcp.test.ts` 等调用点零改动）。
export type { McpServerOptions, ResourcePort, PromptPort } from '../ports/mcp/mcpServerOptions.ts';
