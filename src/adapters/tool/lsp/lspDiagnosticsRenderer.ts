/**
 * 诊断报告的**唯一渲染口径**（工具与写后回灌共用）。
 *
 * 抽出来的理由：`lsp_diagnostics` 工具（模型主动查）与「写后自动回灌」（P1-⑦ 装饰器）
 * 必须对同一个 {@link LspDiagnosticReport} 给出**逐字一致**的文本——否则模型会看到
 * 两种口径的同一份事实，多一处漂移就多一处误判。
 *
 * 诚实优先（与端口注释一致）：`stale` **绝不**渲染成「通过」，必须写明「这不代表没有错误」。
 */
import type { LspDiagnostic, LspDiagnosticReport } from '../../../ports/tool/lsp.js';

/** 单次回传的诊断条数上限（防一个坏文件把上下文刷满）。 */
export const MAX_RENDERED_DIAGNOSTICS = 50;

/**
 * 诊断报告渲染器（无状态，纯静态）。
 */
export class LspDiagnosticsRenderer {
  /**
   * 渲染报告。
   *
   * @param report 诊断报告（含新鲜度）。
   * @param max 最多渲染的条数（≤0 时取 1）。
   * @returns 可读文本。
   */
  public static render(
    report: LspDiagnosticReport,
    max: number = MAX_RENDERED_DIAGNOSTICS,
  ): string {
    const limit = max > 0 ? max : 1;
    if (report.status === 'stale') {
      const cached =
        report.diagnostics.length === 0
          ? '缓存也是空的'
          : `以下是 ${String(report.diagnostics.length)} 条缓存结果`;
      return (
        `${report.file}: 未在等待窗口内收到语言服务器的诊断推送（${cached}）。\n` +
        '**这不代表没有错误**——请勿据此判定「编译通过」。可稍后重试本工具，或用 shell 跑一次类型检查。'
      );
    }
    if (report.diagnostics.length === 0) {
      return `${report.file}: 无诊断（该文件的语法/类型检查通过）。`;
    }
    const shown = report.diagnostics.slice(0, limit);
    const lines = shown.map((diagnostic) => LspDiagnosticsRenderer.line(diagnostic));
    const more =
      report.diagnostics.length > shown.length
        ? `\n… 另有 ${String(report.diagnostics.length - shown.length)} 条未显示`
        : '';
    return `${report.file}: 共 ${String(report.diagnostics.length)} 条诊断\n${lines.join('\n')}${more}`;
  }

  /**
   * 报告里是否存在**错误级**诊断（用于「写后回灌」只在真有问题时才出声）。
   *
   * @param report 诊断报告。
   * @returns 含 severity==='error' 的诊断时为 true（`stale` 一律为 false，不据此制造噪声）。
   */
  public static hasErrors(report: LspDiagnosticReport): boolean {
    return report.status === 'fresh' && report.diagnostics.some((d) => d.severity === 'error');
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
    return `${diagnostic.severity} ${String(line)}:${String(character)} ${diagnostic.message}${code}`;
  }
}
