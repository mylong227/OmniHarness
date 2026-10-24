import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import type { ModelPort } from '../../../ports/model/model.ts';
import { ReasoningBudget } from '../../../util/reasoningBudget.ts';
import type {
  ReviewFinding,
  ReviewPort,
  ReviewReport,
  ReviewRequest,
  ReviewSeverity,
} from '../../../ports/tool/review.ts';
import { log } from '../../../util/logger.ts';

/**
 * `review_diff` 工具（VER-01）：干净上下文的独立审查者。
 *
 * 为什么要单独一个工具、而不是 `subagent`：subagent 默认继承父上下文/工作区，容易
 * “再问一遍同一段思考”；本工具只吃 diff + 目标 + 测试结果，从实现反推规格。
 * 输出结构化 findings，主循环可据此决定是否阻断/告警。
 */
export class ReviewDiffTool implements ReviewPort {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.reviewDiff,
    description:
      '独立审查一段 diff：只接收 diff、任务目标与测试结果，不读取父会话历史。' +
      '返回按严重度排序的缺陷/回归/安全风险（含 file:line 与证据），用于完成前自检。',
    parameters: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'unified diff 或文件变更摘要。' },
        goal: { type: 'string', description: '任务目标/验收标准。' },
        tests: { type: 'string', description: '相关测试输出或验证结果（可选）。' },
      },
      required: ['diff', 'goal'],
    },
  };

  /**
   * @param model 审查模型（与主模型可不同；由组合根注入）。
   */
  public constructor(private readonly model: ModelPort) {}

  /**
   * 执行审查。
   * @param call 工具调用。
   * @param _context 工具上下文（本工具刻意不读）。
   * @returns 渲染后的审查结果。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const diff = String(call.arguments['diff'] ?? '');
    const goal = String(call.arguments['goal'] ?? '');
    if (diff.trim() === '' || goal.trim() === '') {
      return { callId: call.id, ok: false, error: 'review_diff 需要非空 diff 与 goal' };
    }
    const report = await this.review({
      diff,
      goal,
      ...(typeof call.arguments['tests'] === 'string' ? { tests: call.arguments['tests'] } : {}),
    });
    if (!report.ok) {
      return { callId: call.id, ok: false, error: '审查模型未返回可解析的结构化结果' };
    }
    // VER-05：把发现计为可观测事件（采纳/驳回由使用方另记；这里先保证“报了什么”可查）。
    log.info('review.findings', {
      sessionId: _context.sessionId,
      findings: report.findings.length,
      severities: report.findings.map((finding) => finding.severity),
    });
    return { callId: call.id, ok: true, output: ReviewDiffTool.render(report.findings) };
  }

  /**
   * 调用模型做独立审查。
   * @param request 审查输入。
   * @returns 结构化报告（解析失败时 ok:false，raw 保留原文）。
   */
  public async review(request: ReviewRequest): Promise<ReviewReport> {
    const output = await this.model.generate({
      messages: [
        { role: 'system', content: ReviewDiffTool.SYSTEM },
        {
          role: 'user',
          content: `任务目标：\n${request.goal}\n\n测试结果：\n${
            request.tests ?? '（未提供）'
          }\n\n待审查 diff：\n${request.diff}`,
        },
      ],
      tools: [],
      role: 'reviewer',
      reasoningEffort: ReasoningBudget.auxiliary('reviewer', undefined),
      maxOutputTokens: 4_000,
    });
    const raw = output.text ?? '';
    const findings = ReviewDiffTool.parse(raw);
    return { ok: findings !== undefined, findings: findings ?? [], raw };
  }

  /**
   * 渲染 findings（按严重度排序；无发现时明确写 advisory）。
   * @param findings 审查发现。
   * @returns 给模型/用户看的文本。
   */
  private static render(findings: readonly ReviewFinding[]): string {
    if (findings.length === 0) {
      return '审查未发现可报告的问题（advisory；不代表绝对无缺陷，仍应以测试/运行为准）。';
    }
    const order: Record<ReviewSeverity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
    const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
    return [
      `审查发现 ${String(sorted.length)} 条：`,
      ...sorted.map(
        (finding, index) =>
          `${String(index + 1)}. [${finding.severity}] ${finding.file}${
            finding.line === undefined ? '' : `:${String(finding.line)}`
          } — ${finding.issue}\n   证据：${finding.evidence}${
            finding.suggestion === undefined ? '' : `\n   建议：${finding.suggestion}`
          }`,
      ),
    ].join('\n');
  }

  /**
   * 解析模型输出为 findings。容忍 markdown 围栏与对象包裹；非法返回 undefined。
   * @param raw 模型原始文本。
   * @returns findings；无法解析时为 undefined。
   */
  private static parse(raw: string): readonly ReviewFinding[] | undefined {
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' &&
            parsed !== null &&
            Array.isArray((parsed as { findings?: unknown }).findings)
          ? (parsed as { findings: unknown[] }).findings
          : undefined;
      if (list === undefined) return undefined;
      return list
        .map((item) => ReviewDiffTool.normalize(item))
        .filter((item): item is ReviewFinding => item !== undefined)
        .slice(0, 20);
    } catch {
      return undefined;
    }
  }

  /**
   * 归一化一条 finding（字段缺失/非法时返回 undefined，不臆造）。
   * @param value 原始项。
   * @returns 合法 finding 或 undefined。
   */
  private static normalize(value: unknown): ReviewFinding | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const item = value as Record<string, unknown>;
    const file = typeof item['file'] === 'string' ? item['file'] : '';
    const issue = typeof item['issue'] === 'string' ? item['issue'] : '';
    if (file === '' || issue === '') return undefined;
    const severity = ReviewDiffTool.severityOf(item['severity']);
    return {
      severity,
      file,
      ...(typeof item['line'] === 'number' && Number.isFinite(item['line'])
        ? { line: Math.trunc(item['line']) }
        : {}),
      issue,
      evidence: typeof item['evidence'] === 'string' ? item['evidence'] : '（模型未给出证据）',
      ...(typeof item['suggestion'] === 'string' ? { suggestion: item['suggestion'] } : {}),
    };
  }

  /**
   * 严重度归一化（未知值按 major 处理，宁可多报不可漏报）。
   * @param value 原始值。
   * @returns 合法严重度。
   */
  private static severityOf(value: unknown): ReviewSeverity {
    return value === 'blocker' || value === 'major' || value === 'minor' || value === 'nit'
      ? value
      : 'major';
  }

  /** 审查系统提示：强调干净上下文、证据、只报站得住的问题。 */
  private static readonly SYSTEM =
    '你是独立代码审查者。你只能看到任务目标、测试结果和 diff，不能假设自己看过作者的历史。' +
    '只报告能站住的问题：触发条件 + 影响 + 证据（文件/行/代码片段）。不要做风格偏好评审，不要重写代码。' +
    '输出严格 JSON 数组，每项 {"severity":"blocker|major|minor|nit","file":"...","line":123,"issue":"...","evidence":"...","suggestion":"..."}。' +
    '没有问题时输出 []。';
}
