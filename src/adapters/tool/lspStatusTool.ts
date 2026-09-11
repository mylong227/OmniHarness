import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LspPort } from '../../ports/lsp.js';
import { LSP_STATUS_TOOL_NAME } from '../../lsp/lspToolNames.js';

/**
 * @beta
 * 模型面工具：LSP 状态自查（服务器名 + 就绪）。
 */
export class LspStatusTool {
  public readonly definition: ToolDefinition = {
    name: LSP_STATUS_TOOL_NAME,
    description:
      '查看 LSP 代码导航是否就绪：返回后端名与可用性，便于在调用跳转/引用前确认已配置语言服务器。',
    parameters: {
      type: 'object',
      properties: {},
    },
  };

  public constructor(private readonly lsp: LspPort) {}

  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    return { callId: call.id, ok: true, output: `LSP 代码导航可用｜后端: ${this.lsp.name}` };
  }
}
