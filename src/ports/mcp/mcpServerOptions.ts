import type { ToolContext, ToolPort } from '../tool/tool.js';
import type { Transport } from '../../server/transport/lineTransport.js';
import type {
  McpServerInfo,
  McpResourceDescriptor,
  McpResourceContent,
  McpPromptDescriptor,
} from '../../mcp/mcpProtocol.js';
import type { ToolGatePort } from '../runtime/toolGatePort.js';

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
 * MCP 服务端选项。`gate` 引用 ports 层 `ToolGatePort`，不再依赖 core 实现，解除 `ports→core` 禁边。
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
}
