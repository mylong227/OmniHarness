import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LspPort } from '../../ports/lsp.js';
import { LSP_HOVER_TOOL_NAME } from '../../lsp/lspToolNames.js';
import { parseTarget } from './lspToolsShared.js';

/**
 * @beta
 * 模型面工具：悬停文档。
 */
export class LspHoverTool {
  /**
   * 工具定义：lsp_hover 工具的名称、描述与参数 schema。
   * 让模型获取光标处符号的悬停文档（类型签名/注释，需已配置 LSP 服务器）。
   */
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

  /**
   * 执行 lsp_hover：解析目标位置并委托 LspPort 取悬停文档。
   * @param call 模型传入的工具调用（含 file / line / character）。
   * @param _context 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 命中时返回文档文本；无文档返回提示；LSP 异常返回 ok:false。
   */
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
