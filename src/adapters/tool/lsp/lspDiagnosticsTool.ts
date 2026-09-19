import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LspPort } from '../../../ports/tool/lsp.js';
import { LSP_DIAGNOSTICS_TOOL_NAME } from '../../../adapters/lsp/lspToolNames.js';
import { LspDiagnosticsRenderer } from './lspDiagnosticsRenderer.js';

/**
 * 模型面工具：取文档诊断（编译 / 类型错误）。
 *
 * 为什么要有它：本仓 LSP 原先只到「导航层」（定义/引用/悬停），`publishDiagnostics`
 * 被显式忽略 ⇒ 模型改完代码拿不到任何编译错误，只能再跑一次构建（而构建在 30s shell 硬顶下
 * 还常常跑不完）。本工具把「改完立刻知道错在哪」这条闭环补上。
 *
 * **诚实优先**：语言服务器是异步推送诊断的，窗口内没收到推送 ≠ 没有错误。
 * 因此 `stale` 报告会被渲染成明确的「不确定」提示，绝不让模型把「没等到」读成「编译通过」
 * （渲染口径统一在 {@link LspDiagnosticsRenderer}，与写后自动回灌逐字一致）。
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
      return { callId: call.id, ok: true, output: LspDiagnosticsRenderer.render(report) };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 诊断失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
