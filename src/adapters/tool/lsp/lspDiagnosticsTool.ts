import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LspDiagnostic, LspDiagnosticReport, LspPort } from '../../../ports/tool/lsp.js';
import { LSP_DIAGNOSTICS_TOOL_NAME } from '../../../adapters/lsp/lspToolNames.js';

/** 单次回传的诊断条数上限（防一个坏文件把上下文刷满）。 */
const MAX_DIAGNOSTICS = 50;

/**
 * 模型面工具：取文档诊断（编译 / 类型错误）。
 *
 * 为什么要有它：本仓 LSP 原先只到「导航层」（定义/引用/悬停），`publishDiagnostics`
 * 被显式忽略 ⇒ 模型改完代码拿不到任何编译错误，只能再跑一次构建（而构建在 30s shell 硬顶下
 * 还常常跑不完）。本工具把「改完立刻知道错在哪」这条闭环补上。
 *
 * **诚实优先**：语言服务器是异步推送诊断的，窗口内没收到推送 ≠ 没有错误。
 * 因此 `stale` 报告会被渲染成明确的「不确定」提示，绝不让模型把「没等到」读成「编译通过」。
 */
export class LspDiagnosticsTool {
  /**
   * 工具定义。
   */
  public readonly definition: ToolDefinition = {
    name: LSP_DIAGNOSTICS_TOOL_NAME,
    description:
      '获取指定文件的编译/类型错误诊断（需已配置 LSP 服务器）。' +
      '改完代码后用它即时查错，不必先跑一次完整构建。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件的绝对路径。' },
      },
      required: ['file'],
    },
  };

  /**
   * @param lsp LSP 端口（须实现可选的 `diagnostics`；未实现时本工具会给出明确失败）。
   */
  public constructor(private readonly lsp: LspPort) {}

  /**
   * 执行 lsp_diagnostics：委托 LspPort 取诊断并渲染。
   *
   * @param call 模型传入的工具调用（含 file）。
   * @param _context 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 命中时返回诊断清单；无诊断按新鲜度分别渲染；LSP 异常或能力缺失返回 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const file = String(call.arguments['file'] ?? '').trim();
    if (file === '') {
      return { callId: call.id, ok: false, error: '缺少文件参数: file' };
    }
    const diagnose = this.lsp.diagnostics;
    if (diagnose === undefined) {
      return {
        callId: call.id,
        ok: false,
        error: '当前 LSP 适配器不支持诊断（LspPort.diagnostics 未实现）',
      };
    }
    try {
      const report = await diagnose.call(this.lsp, file);
      return { callId: call.id, ok: true, output: LspDiagnosticsTool.render(report) };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 诊断失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 渲染诊断报告（含新鲜度语义）。
   *
   * @param report 诊断报告。
   * @returns 可读文本。
   */
  private static render(report: LspDiagnosticReport): string {
    if (report.status === 'stale') {
      const cached =
        report.diagnostics.length === 0
          ? '缓存也是空的'
          : `以下是 ${report.diagnostics.length} 条缓存结果`;
      return (
        `${report.file}: 未在等待窗口内收到语言服务器的诊断推送（${cached}）。\n` +
        '**这不代表没有错误**——请勿据此判定「编译通过」。可稍后重试本工具，或用 shell 跑一次类型检查。'
      );
    }
    if (report.diagnostics.length === 0) {
      return `${report.file}: 无诊断（该文件的语法/类型检查通过）。`;
    }
    const shown = report.diagnostics.slice(0, MAX_DIAGNOSTICS);
    const lines = shown.map((diagnostic) => LspDiagnosticsTool.line(diagnostic));
    const more =
      report.diagnostics.length > shown.length
        ? `\n… 另有 ${report.diagnostics.length - shown.length} 条未显示`
        : '';
    return `${report.file}: 共 ${report.diagnostics.length} 条诊断\n${lines.join('\n')}${more}`;
  }

  /**
   * 渲染单条诊断。
   *
   * @param diagnostic 归一化诊断。
   * @returns `严重度 行:列 消息 [码]` 形式的单行文本。
   */
  private static line(diagnostic: LspDiagnostic): string {
    const { line, character } = diagnostic.range.start;
    const code = diagnostic.code === undefined ? '' : ` [${diagnostic.code}]`;
    return `${diagnostic.severity} ${line}:${character} ${diagnostic.message}${code}`;
  }
}
