import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LspCodeAction, LspPort } from '../../../ports/tool/lsp.js';
import { LSP_CODE_ACTION_TOOL_NAME } from '../../../adapters/lsp/lspToolNames.js';
import { parseTarget } from './lspToolsShared.js';

/** 单条编辑文本在渲染时的截断长度（重构编辑可达数万字符，全渲染会吃光上下文）。 */
const MAX_TEXT_CHARS = 400;

/**
 * @beta
 * 模型面工具：查询某区间可用的代码操作（快速修复 / 重构建议）。
 *
 * **只呈现，不落盘**：本工具返回「改哪儿、改成什么」，真正的应用必须走写类工具
 * （`edit` / `apply_patch`）并接受既有的审批与沙箱裁决。把「查建议」和「应用建议」
 * 合成一个工具会让它在 `toolGate` 里必须被归类为写操作，从而在 plan 模式下整条被拦——
 * 那等于为了一个便利牺牲掉「先看再改」的检查点。
 */
export class LspCodeActionTool {
  /**
   * 工具定义：lsp_code_action 的名称、描述与参数 schema。
   */
  public readonly definition: ToolDefinition = {
    name: LSP_CODE_ACTION_TOOL_NAME,
    description:
      '查询指定区间可用的代码操作（快速修复/重构建议），返回标题、种类与每处编辑的位置和替换文本。只读：不会修改任何文件，需自行用 edit 应用（需已配置 LSP 服务器）。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件的绝对路径。' },
        line: { type: 'number', description: '起始行号（>=1，编辑器行号）。' },
        character: { type: 'number', description: '起始列号（>=1，编辑器列号）。' },
        end_line: { type: 'number', description: '结束行号（>=1，默认与 line 相同）。' },
        end_character: {
          type: 'number',
          description: '结束列号（>=1，默认取一个大于起始列的值以覆盖光标处符号）。',
        },
        kind: {
          type: 'string',
          description: '按种类前缀过滤，如 quickfix / refactor。缺省返回全部。',
        },
      },
      required: ['file', 'line', 'character'],
    },
  };

  public constructor(private readonly lsp: LspPort) {}

  /**
   * 执行 lsp_code_action：解析区间与过滤条件，委托 LspPort 查询后渲染。
   *
   * @param call 模型传入的工具调用（含 file / line / character / 可选范围与 kind）。
   * @param _context 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 操作清单文本；无操作返回提示；参数或 LSP 异常返回 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const target = parseTarget(call);
    if ('error' in target) {
      return { callId: call.id, ok: false, error: target.error };
    }
    const range = {
      start: { line: target.line, character: target.character },
      end: {
        line: LspCodeActionTool.positiveInt(call.arguments['end_line']) ?? target.line,
        character:
          LspCodeActionTool.positiveInt(call.arguments['end_character']) ?? target.character + 1,
      },
    };
    const kind = String(call.arguments['kind'] ?? '').trim();
    try {
      const actions = (await this.lsp.codeActions?.(target.file, range)) ?? [];
      const filtered =
        kind === '' ? actions : actions.filter((action) => LspCodeActionTool.matches(action, kind));
      if (filtered.length === 0) {
        return { callId: call.id, ok: true, output: '未找到可用的代码操作' };
      }
      return {
        callId: call.id,
        ok: true,
        output: filtered.map(LspCodeActionTool.render).join('\n'),
      };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 代码操作查询失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 按**前缀**匹配种类：`quickfix` 应同时接受 `quickfix` 与 `quickfix.foo`。
   *
   * 用前缀而非全等，是因为 LSP 的 kind 是点分层级，模型给不出完整子类名很正常；
   * 但前缀必须落在点边界上（`refactor` 不该匹配到 `refactoring`）。
   *
   * @param action 归一化后的操作。
   * @param kind 过滤前缀。
   * @returns 命中为 true。
   */
  private static matches(action: LspCodeAction, kind: string): boolean {
    const actual = action.kind ?? '';
    return actual === kind || actual.startsWith(`${kind}.`);
  }

  /**
   * 渲染单条操作及其编辑。
   *
   * @param action 归一化后的操作。
   * @returns 多行文本（首行标题，随后缩进的编辑行）。
   */
  private static render(action: LspCodeAction): string {
    const kind = action.kind !== undefined ? ` [${action.kind}]` : '';
    const preferred = action.isPreferred ? ' (preferred)' : '';
    const head = `- ${action.title}${kind}${preferred}`;
    if (action.edits.length === 0) {
      // 只有 command 的操作没有可渲染的编辑；说清楚「有操作但没有可读改动」，
      // 而不是渲染成空行让模型以为解析失败。
      return `${head}\n    （该操作由命令实现，无文本编辑可预览）`;
    }
    const edits = action.edits.map((edit) => {
      const text =
        edit.newText.length > MAX_TEXT_CHARS
          ? `${edit.newText.slice(0, MAX_TEXT_CHARS)}…（截断，原长 ${edit.newText.length}）`
          : edit.newText;
      return `    ${edit.file}:${edit.range.start.line}:${edit.range.start.character}: ${JSON.stringify(text)}`;
    });
    return [head, ...edits].join('\n');
  }

  /**
   * 把可选参数解析成 >=1 的整数。
   *
   * @param raw 原始参数值。
   * @returns 合法时为该整数；缺失/非法为 undefined（调用方走默认值）。
   */
  private static positiveInt(raw: unknown): number | undefined {
    if (raw === undefined || raw === null || raw === '') {
      return undefined;
    }
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  }
}
