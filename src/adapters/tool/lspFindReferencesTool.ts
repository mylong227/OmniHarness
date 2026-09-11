import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LspPort } from '../../ports/lsp.js';
import { LSP_FIND_REFERENCES_TOOL_NAME } from '../../lsp/lspToolNames.js';
import { renderLocation, parseTarget } from './lspToolsShared.js';

/**
 * @beta
 * 模型面工具：查找符号的全部引用。
 */
export class LspFindReferencesTool {
  public readonly definition: ToolDefinition = {
    name: LSP_FIND_REFERENCES_TOOL_NAME,
    description:
      '查找光标处符号的全部引用位置（需已配置 LSP 服务器）。返回 file:line:col 定位列表（含声明处）。',
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
      const locs = await this.lsp.references(target.file, target.line, target.character);
      if (locs.length === 0) {
        return { callId: call.id, ok: true, output: '未找到引用' };
      }
      return { callId: call.id, ok: true, output: locs.map(renderLocation).join('\n') };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 查找引用失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
