/**
 * MCP 请求方法表与业务处理器（`initialize` / `server/discover` / tools / resources / prompts）。
 *
 * 从 `McpServer` 拆出的第三条职责线：把「方法名 → 处理器」的注册、分发以及各方法的
 * 参数校验/结果构造收在一处。`McpServer` 只负责 `_meta` 解析、trace 关联与结果装饰，
 * 不再持有方法实现，避免单类堆积成上帝类。
 *
 * 行为契约（拆分前不变）：未知方法 → `-32601`；缺参数 → `-32602`；工具调用先过 MRTR
 * live handler，再过门禁，最后才执行；`tools/list` 保持名字升序的确定性排序。
 */
import type { ToolCall } from '../ports/tool/tool.ts';
import type { McpCapabilities, McpServerInfo } from '../ports/mcp/mcpProtocolTypes.ts';
import type { McpServerOptions } from '../ports/mcp/mcpServerOptions.ts';
import { Id } from '../util/id.ts';
import { McpCachePolicy } from './mcpCachePolicy.ts';
import { McpError } from './mcpError.ts';
import { McpInputRequiredService } from './mcpInputRequiredService.ts';
import { McpProtocol, mcpProtocol } from './mcpProtocol.ts';
import type { ParsedMcpRequestContext } from './mcpRequestContext.ts';
import { mcpToolMapper } from './mcpToolMapper.ts';

/** 请求处理器签名。 */
type McpRequestHandler = (
  params: Record<string, unknown>,
  context: ParsedMcpRequestContext,
) => Promise<unknown>;

/** 服务端能力：三类 listChanged、资源订阅、扩展协商位。 */
const capabilitiesOf = (options: McpServerOptions): McpCapabilities => ({
  tools: { listChanged: true },
  resources: { subscribe: true, listChanged: true },
  prompts: { listChanged: true },
  extensions: { ...(options.extensions ?? {}) },
});

/** 提取调用参数（非对象视为空参数）。 */
const argumentsOf = (params: Record<string, unknown>): Record<string, unknown> => {
  const raw = params['arguments'];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
};

/**
 * 方法表与业务处理器。
 */
export class McpMethodService {
  /** 方法 → 处理器（只含请求方法；通知另由订阅服务处理）。 */
  private readonly handlers = new Map<string, McpRequestHandler>();
  /** 服务端选项（工具集 / 门禁 / 资源与提示后端 / 会话上下文）。 */
  private readonly options: McpServerOptions;
  /** 对外上报的服务端信息。 */
  private readonly serverInfo: McpServerInfo;
  /** 可缓存结果策略。 */
  private readonly cache: McpCachePolicy;
  /** MRTR 服务（tools/call 的 input_required 往返）。 */
  private readonly input: McpInputRequiredService;

  /**
   * @param options 服务端选项。
   * @param serverInfo 对外上报的服务端信息。
   * @param cache 可缓存结果策略。
   */
  public constructor(options: McpServerOptions, serverInfo: McpServerInfo, cache: McpCachePolicy) {
    this.options = options;
    this.serverInfo = serverInfo;
    this.cache = cache;
    this.input = new McpInputRequiredService(options, serverInfo);
    this.registerHandlers();
  }

  /**
   * 按方法名分发（未知方法 → `-32601`）。
   * @param method 方法名。
   * @param params 参数。
   * @param context 请求上下文。
   * @returns 处理器结果。
   */
  public async dispatch(
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
    return mcpProtocol.initializeResult(this.serverInfo, capabilitiesOf(this.options));
  }

  /**
   * 2026-07-28 无状态发现（不要求 initialize 握手）。
   * @returns DiscoverResult（含缓存字段）。
   */
  private discover(): unknown {
    return mcpProtocol.discoverResult(this.serverInfo, {
      capabilities: capabilitiesOf(this.options),
      supportedVersions: McpProtocol.SUPPORTED_VERSIONS,
      cache: this.cache.fieldsFor(McpProtocol.METHOD_SERVER_DISCOVER),
    });
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
   *
   * 公开而非私有：`McpServer.listTools` 的既有测试缝直接调用该方法（拆分前就如此），
   * 服务端以薄委托保持这条运行时可达路径不变。
   * @returns `{tools}`。
   */
  public listTools(): unknown {
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
    const call: ToolCall = { id: Id.id('mcp'), name, arguments: argumentsOf(params) };
    const decision = await this.input.decide(call, params, context);
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
        return this.input.resultOf(decision, call);
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
    const text = await backend.get(name, argumentsOf(params));
    return { description: name, messages: [{ role: 'user', content: { type: 'text', text } }] };
  }
}
