import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LspPort } from '../../ports/lsp.js';
import { LSP_HOVER_TOOL_NAME } from '../../lsp/lspToolNames.js';
import { parseTarget } from './lspToolsShared.js';

/**
 * @beta
 * 模型面工具：悬停文档。
 */
export class LspHoverTool {
  public readonly definition: ToolDefinition = {
    name: LSP_HOVER_TOOL_NAME,
    description:
      '获取光标处符号的悬停文档（类型签名/注释，需已配置 LSP 服务器）。返回文档文本，无则提示无文档。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件的绝对路径。' },
        line: { type: 'number', description: '行号（>=1，编辑器行号）。' },
        character: { type: 'number', description: '列号（>=1，编辑器列号）。' },
      },
      required: ['file', 'line', 'character'],
    },
  };

  public constructor(private readonly lsp: LspPort) {}

  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const target = parseTarget(call);
    if ('error' in target) {
      return { callId: call.id, ok: false, error: target.error };
    }
    try {
      const doc = await this.lsp.hover(target.file, target.line, target.character);
      return { callId: call.id, ok: true, output: doc ?? '无悬停文档' };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 悬停失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
