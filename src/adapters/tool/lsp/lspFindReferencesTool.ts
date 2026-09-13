import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LspPort } from '../../../ports/tool/lsp.js';
import { LSP_FIND_REFERENCES_TOOL_NAME } from '../../../adapters/lsp/lspToolNames.js';
import { renderLocation, parseTarget } from './lspToolsShared.js';

/**
 * @beta
 * 模型面工具：查找符号的全部引用。
 */
export class LspFindReferencesTool {
  /**
   * 工具定义：lsp_find_references 工具的名称、描述与参数 schema。
   * 让模型按文件路径 + 行列定位符号的全部引用位置（需已配置 LSP 服务器）。
   */
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

  /**
   * 执行 lsp_find_references：解析目标位置并委托 LspPort 查询引用。
   * @param call 模型传入的工具调用（含 file / line / character）。
   * @param _context 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 命中引用以 file:line:col 列表返回；无引用返回提示；解析失败或 LSP 异常返回 ok:false。
   */
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
