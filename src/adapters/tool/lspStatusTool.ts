import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LspPort } from '../../ports/lsp.js';
import { LSP_STATUS_TOOL_NAME } from '../../lsp/lspToolNames.js';

/**
 * @beta
 * 模型面工具：LSP 状态自查（服务器名 + 就绪）。
 */
export class LspStatusTool {
  /**
   * 工具定义：lsp_status 工具的名称、描述与参数 schema。
   * 返回后端 LSP 代码导航是否就绪，便于调用跳转/引用前确认语言服务器已配置。
   */
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

  /**
   * 执行 lsp_status：返回后端名与就绪状态。
   * @param call 模型传入的工具调用（本工具无参数）。
   * @param _context 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 始终 ok:true，output 含后端名与可用性说明。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    return { callId: call.id, ok: true, output: `LSP 代码导航可用｜后端: ${this.lsp.name}` };
  }
}
