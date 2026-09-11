import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LspPort } from '../../ports/lsp.js';
import { LSP_GO_TO_DEFINITION_TOOL_NAME } from '../../lsp/lspToolNames.js';
import { renderLocation, parseTarget } from './lspToolsShared.js';

/**
 * @beta
 * 模型面工具：跳转到符号定义。
 */
export class LspGoToDefinitionTool {
  public readonly definition: ToolDefinition = {
    name: LSP_GO_TO_DEFINITION_TOOL_NAME,
    description:
      '跳转到光标处符号的定义位置（需已配置 LSP 服务器，如 typescript-language-server）。返回 0..n 个 file:line:col 定位。',
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
      const locs = await this.lsp.definition(target.file, target.line, target.character);
      if (locs.length === 0) {
        return { callId: call.id, ok: true, output: '未找到定义' };
      }
      return { callId: call.id, ok: true, output: locs.map(renderLocation).join('\n') };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 跳转定义失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
