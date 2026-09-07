import type { ToolCall, ToolContext, ToolPort } from '../ports/tool.js';
import type { ToolGate } from '../core/toolGate.js';
import { id } from '../util/id.js';
import { JsonRpc, type RpcMessage, type RpcRequest } from '../server/jsonRpc.js';
import type { Transport } from '../server/lineTransport.js';
import { McpProtocol, type McpServerInfo, type McpResourceDescriptor, type McpResourceContent, type McpPromptDescriptor } from './mcpProtocol.js';
import { McpToolMapper } from './mcpToolMapper.js';

/**
 * @beta
 * 资源后端端口：MCP 服务端以此把宿主资源（文件、文档、KV 等）暴露为 resources/list + resources/read。
 * 可选；未注入时服务端对 resources/* 返回空列表（符合协议，不伪造数据）。
 */
export interface ResourcePort {
  readonly name: string;
  list(): Promise<readonly McpResourceDescriptor[]>;
  read(uri: string): Promise<McpResourceContent>;
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
 * MCP 服务端选项。
 */
export interface McpServerOptions {
  readonly transport: Transport;
  readonly tools: ToolPort;
  readonly context: ToolContext;
  readonly serverInfo?: McpServerInfo;
  /** 可选门禁：注入后外部 MCP 调用同样过审批 + 沙箱。 */
  readonly gate?: ToolGate;
  /** 可选资源后端：注入后服务端应答 resources/*。 */
  readonly resources?: ResourcePort;
  /** 可选提示模板后端：注入后服务端应答 prompts/*。 */
  readonly prompts?: PromptPort;
}

/**
 * @beta
 * MCP 服务端：把 OmniHarness 工具集以 initialize/tools/list/tools/call 暴露给任意 MCP 客户端。
 */
export class McpServer {
  private readonly handlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<unknown>
  >();

  constructor(private readonly options: McpServerOptions) {
    this.registerHandlers();
    options.transport.onMessage((message) => void this.handle(message));
  }

  /** 处理入站消息（无 id 的通知忽略）。 */
  async handle(message: RpcMessage): Promise<void> {
    if (!JsonRpc.isRequest(message)) {
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      this.replyError(message, McpProtocol.ERROR_METHOD_NOT_FOUND, `方法不存在: ${message.method}`);
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      this.options.transport.send(JsonRpc.response(message.id, result));
    } catch (error) {
      this.replyError(message, McpProtocol.ERROR_INVALID_PARAMS, this.messageOf(error));
    }
  }

  /** 注册 MCP 方法。 */
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
    return McpProtocol.initializeResult(
      this.options.serverInfo ?? { name: 'omniharness', version: '0.1.0' },
    );
  }

  /** 列举工具（本地定义 → MCP 描述）。 */
  private async listTools(): Promise<unknown> {
    return {
      tools: this.options.tools.list().map((definition) => McpToolMapper.toDescriptor(definition)),
    };
  }

  /** 调用工具（可选过门禁 → 执行 → 结果转 MCP 内容）。 */
  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params['name'];
    if (typeof name !== 'string') {
      throw new Error('tools/call 缺少 name');
    }
    const call: ToolCall = { id: id('mcp'), name, arguments: this.argumentsOf(params) };
    const denied = await this.gateOf(call);
    if (denied !== undefined) {
      return McpProtocol.toolResult(denied.output, denied.error);
    }
    const result = await this.options.tools.execute(call, this.options.context);
    return McpProtocol.toolResult(result.output, result.error);
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

  /** 门禁裁决（未注入门禁直接放行）。 */
  private async gateOf(call: ToolCall): Promise<{ output?: string; error?: string } | undefined> {
    const gate = this.options.gate;
    if (gate === undefined) {
      return undefined;
    }
    return gate.gate(call, this.options.context.sessionId);
  }

  /** 回复错误响应。 */
  private replyError(request: RpcRequest, code: number, message: string): void {
    this.options.transport.send(JsonRpc.errorResponse(request.id, code, message));
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
