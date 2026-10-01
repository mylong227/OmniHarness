import type { ToolCall } from '../ports/tool/tool.js';
import type { McpServerOptions } from '../ports/mcp/mcpServerOptions.js';
import { Id } from '../util/id.js';
import { jsonRpc, type RpcMessage, type RpcRequest } from '../server/core/jsonRpc.js';
import { McpProtocol, mcpProtocol } from './mcpProtocol.js';
import { mcpToolMapper } from './mcpToolMapper.js';

/**
 * @beta
 * MCP 服务端：把 OmniHarness 工具集以 initialize/tools/list/tools/call 暴露给任意 MCP 客户端。
 */
export class McpServer {
  private readonly handlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<unknown>
  >();

  public constructor(private readonly options: McpServerOptions) {
    this.registerHandlers();
    options.transport.onMessage((message) => void this.handle(message));
  }

  /** 处理入站消息（无 id 的通知忽略）。
   * @returns 无返回值。
   */
  public async handle(message: RpcMessage): Promise<void> {
    if (!jsonRpc.isRequest(message)) {
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      this.replyError(message, McpProtocol.ERROR_METHOD_NOT_FOUND, `方法不存在: ${message.method}`);
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      this.options.transport.send(jsonRpc.response(message.id, result));
    } catch (error) {
      this.replyError(message, McpProtocol.ERROR_INVALID_PARAMS, this.messageOf(error));
    }
  }

  /** 注册 MCP 方法。
   * @returns 无返回值。
   */
  private registerHandlers(): void {
    this.handlers.set(McpProtocol.METHOD_INITIALIZE, () => this.initialize());
    this.handlers.set(McpProtocol.METHOD_PING, async () => ({}));
    this.handlers.set(McpProtocol.METHOD_TOOLS_LIST, async () => this.listTools());
    this.handlers.set(McpProtocol.METHOD_TOOLS_CALL, (params) => this.callTool(params));
    this.handlers.set(McpProtocol.METHOD_RESOURCES_LIST, async () => this.listResources());
    this.handlers.set(McpProtocol.METHOD_RESOURCES_READ, (params) => this.readResource(params));
    this.handlers.set(McpProtocol.METHOD_PROMPTS_LIST, async () => this.listPrompts());
    this.handlers.set(McpProtocol.METHOD_PROMPTS_GET, (params) => this.getPrompt(params));
  }

  /** 握手：返回协议版本与能力声明。 */
  private async initialize(): Promise<unknown> {
    return mcpProtocol.initializeResult(
      this.options.serverInfo ?? { name: 'omniharness', version: '0.1.0' },
    );
  }

  /** 列举工具（本地定义 → MCP 描述）。 */
  private async listTools(): Promise<unknown> {
    return {
      tools: this.options.tools.list().map((definition) => mcpToolMapper.toDescriptor(definition)),
    };
  }

  /** 调用工具（可选过门禁 → 执行 → 结果转 MCP 内容）。 */
  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params['name'];
    if (typeof name !== 'string') {
      throw new Error('tools/call 缺少 name');
    }
    const call: ToolCall = { id: Id.id('mcp'), name, arguments: this.argumentsOf(params) };
    const denied = await this.gateOf(call);
    if (denied !== undefined) {
      return mcpProtocol.toolResult(denied.output, denied.error);
    }
    const result = await this.options.tools.execute(call, this.options.context);
    return mcpProtocol.toolResult(result.output, result.error);
  }

  /** 列举资源（未配置后端返回空列表，符合协议）。 */
  private async listResources(): Promise<unknown> {
    const items = this.options.resources === undefined ? [] : await this.options.resources.list();
    return { resources: items, nextCursor: null };
  }

  /** 读取资源（未配置后端报错，符合协议「资源不存在」语义）。 */
  private async readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = params['uri'];
    if (typeof uri !== 'string') {
      throw new Error('resources/read 缺少 uri');
    }
    const backend = this.options.resources;
    if (backend === undefined) {
      throw new Error(`资源后端未配置，无法读取: ${uri}`);
    }
    return await backend.read(uri);
  }

  /** 列举提示模板（未配置后端返回空列表）。 */
  private async listPrompts(): Promise<unknown> {
    const items = this.options.prompts === undefined ? [] : await this.options.prompts.list();
    return { prompts: items, nextCursor: null };
  }

  /** 获取提示模板（未配置后端报错）。 */
  private async getPrompt(params: Record<string, unknown>): Promise<unknown> {
    const name = params['name'];
    if (typeof name !== 'string') {
      throw new Error('prompts/get 缺少 name');
    }
    const backend = this.options.prompts;
    if (backend === undefined) {
      throw new Error(`提示后端未配置，无法获取: ${name}`);
    }
    const text = await backend.get(name, (params['arguments'] as Record<string, unknown>) ?? {});
    return { description: name, messages: [{ role: 'user', content: { type: 'text', text } }] };
  }

  /** 提取调用参数（非对象视为空参数）。 */
  private argumentsOf(params: Record<string, unknown>): Record<string, unknown> {
    const raw = params['arguments'];
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  }

  /**
   * 门禁裁决。
   *
   * 未注入门禁时**直接放行**是有意设计：McpServer 暴露的是本地可信工具集给受控 MCP 客户端
   * （本地握手 / 同一进程内桥接），与本地 `mcp.test.ts` 的放行语义一致；生产路径经
   * `cliBuildConfig` / `appServer` 装配时一律注入门禁（审批 + 沙箱 + 计划态），不会走到此分支。
   * 外部不可信面（桥接进来的远端工具描述）的提示注入由 `mcpToolMapper.scanToolDescription`
   * 在映射层拦截，二者分工：本方法管「调用是否过审批」，mapper 管「描述是否含注入」。
   * @param call 待裁决的工具调用
   * @returns 拒绝结果（含输出与错误）；未注入门禁或裁决放行时为 undefined
   */
  private async gateOf(
    call: ToolCall,
  ): Promise<{ output?: string | undefined; error?: string | undefined } | undefined> {
    const gate = this.options.gate;
    if (gate === undefined) {
      return undefined;
    }
    return gate.gate(call, this.options.context.sessionId);
  }

  /** 回复错误响应。
   * @returns 无返回值。
   */
  private replyError(request: RpcRequest, code: number, message: string): void {
    this.options.transport.send(jsonRpc.errorResponse(request.id, code, message));
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// `McpServerOptions` / `ResourcePort` / `PromptPort` 的契约已外迁至 `ports/mcp/mcpServerOptions.ts`，
// 此处仅再导出以维持既有公共 API 面（`index.ts`、`mcpServeRunner.ts`、`mcp.test.ts` 等调用点零改动）。
export type { McpServerOptions, ResourcePort, PromptPort } from '../ports/mcp/mcpServerOptions.js';
