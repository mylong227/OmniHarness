import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LspSymbol, LspPort } from '../../../ports/tool/lsp.js';
import { LSP_DOCUMENT_SYMBOLS_TOOL_NAME } from '../../../adapters/lsp/lspToolNames.js';

/**
 * @beta
 * 模型面工具：列出文件的符号目录（函数/类/方法/字段的层级清单）。
 *
 * **为什么值得单独一个工具**：`lsp_go_to_definition` 要求模型**已经知道某个符号在哪一行**；
 * 面对一个没读过的文件，模型只能整读。先给目录、再决定读哪一段，是省上下文最直接的一步——
 * 尤其对上千行的文件，一次符号查询（几十行）往往能省掉一次全文件读取。
 */
export class LspDocumentSymbolsTool {
  /**
   * 工具定义：lsp_document_symbols 的名称、描述与参数 schema。
   */
  public readonly definition: ToolDefinition = {
    name: LSP_DOCUMENT_SYMBOLS_TOOL_NAME,
    description:
      '列出某个文件的符号目录（函数/类/方法/字段），按行列排序，嵌套层级以缩进表示。适合在通读大文件前先摸清结构（需已配置 LSP 服务器）。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件的绝对路径。' },
      },
      required: ['file'],
    },
  };

  public constructor(private readonly lsp: LspPort) {}

  /**
   * 执行 lsp_document_symbols：解析文件参数并委托 LspPort 查询符号。
   *
   * @param call 模型传入的工具调用（含 file）。
   * @param _context 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 符号清单（每行 `<kind> <name> — file:line:col`）；无符号返回提示；LSP 异常返回 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const file = String(call.arguments['file'] ?? '').trim();
    if (file === '') {
      return { callId: call.id, ok: false, error: '缺少文件参数: file' };
    }
    try {
      const symbols = await this.lsp.symbols?.(file);
      const list = symbols ?? [];
      if (list.length === 0) {
        return { callId: call.id, ok: true, output: '未找到符号' };
      }
      return { callId: call.id, ok: true, output: LspDocumentSymbolsTool.render(list) };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 符号查询失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 渲染符号清单：先按（行, 列）排序再逐行输出。
   *
   * 排序而非沿用服务器顺序——层级式返回天然是深度优先，但扁平式（`SymbolInformation`）
   * 顺序由服务器决定，同一文件换个服务器就换一种排法。模型需要的是**稳定的阅读顺序**。
   *
   * @param symbols 符号清单。
   * @returns 多行文本。
   */
  private static render(symbols: readonly LspSymbol[]): string {
    return [...symbols]
      .sort(
        (a, b) =>
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character,
      )
      .map(
        (symbol) =>
          `${symbol.kind} ${symbol.name} — ${symbol.file}:${symbol.range.start.line}:${symbol.range.start.character}`,
      )
      .join('\n');
  }
}
