/**
 * `ask_user` 的 MRTR live handler（2026-07-28）。
 *
 * 现代客户端（声明 `elicitation` 能力）调用 `ask_user` 时，服务端不再让工具直接等待宿主
 * UI（`UserResponder`），而是返回 `resultType:"input_required"` + 一组 `elicitation/create`
 * 请求；客户端把用户答案带 `inputResponses` 重试后，本 handler 直接把答案作为工具结果返回
 * （`kind:"respond"`，不执行原工具）。
 *
 * legacy 客户端（无每请求 `_meta`）保持旧行为（`allow`，由 `AskUserTool` 走 UserResponder）：
 * 新协议能力不破坏旧 stdio 路径。
 */
import type { ToolCall } from '../ports/tool/tool.ts';
import { TOOL_NAMES } from '../ports/tool/toolNames.ts';
import type {
  McpInputRequestSpec,
  McpInputRequests,
  McpInputResponses,
} from '../ports/mcp/mcpProtocolTypes.ts';
import type {
  McpInputRequiredContext,
  McpInputRequiredDecision,
  McpInputRequiredPort,
} from '../ports/mcp/mcpInputRequiredPort.ts';
import { McpElicitation } from './mcpElicitation.ts';

/** 一条问题（从工具参数规整而来）。 */
interface AskQuestionSpec {
  /** 稳定 id（重复 id 会被去重为 `id#index`）。 */
  readonly id: string;
  /** 问题正文。 */
  readonly question: string;
  /** 可选短标题。 */
  readonly header?: string | undefined;
  /** 可选项标签。 */
  readonly options?: readonly string[] | undefined;
}

/** `ask_user` MRTR handler 选项。 */
export interface McpAskUserInputHandlerOptions {
  /** 作用工具名（缺省 `ask_user`）。 */
  readonly toolName?: string | undefined;
}

/**
 * `ask_user` → `elicitation/create` 的 live handler。
 */
export class McpAskUserInputHandler implements McpInputRequiredPort {
  /** 端口名。 */
  public readonly name = 'mcp-ask-user-input';
  /** 作用工具名。 */
  private readonly toolName: string;

  /**
   * @param options 工具名覆盖（测试/宿主可改）。
   */
  public constructor(options: McpAskUserInputHandlerOptions = {}) {
    this.toolName = options.toolName ?? TOOL_NAMES.askUser;
  }

  /**
   * 评估 `ask_user` 调用。
   * @param context 调用与客户端能力/回答。
   * @returns allow（legacy/非目标工具）、deny（缺 elicitation）或 input_required/respond。
   */
  public async evaluate(context: McpInputRequiredContext): Promise<McpInputRequiredDecision> {
    if (context.call.name !== this.toolName) return { kind: 'allow' };
    const questions = McpAskUserInputHandler.questionsOf(context.call);
    if (questions === undefined) return { kind: 'allow' };
    if (!context.modern) return { kind: 'allow' };
    if (!McpAskUserInputHandler.capable(context.clientCapabilities.elicitation)) {
      return {
        kind: 'deny',
        message:
          '客户端未声明 elicitation 能力，ask_user 无法按 MRTR 往返（fail-closed）；' +
          '请在 clientCapabilities 中声明 elicitation',
      };
    }
    if (context.inputResponses === undefined) {
      return this.ask(questions);
    }
    return this.answer(questions, context.inputResponses);
  }

  /**
   * 构造首次输入请求。
   * @param questions 全部问题。
   * @returns `input_required` 裁决。
   */
  private ask(questions: readonly AskQuestionSpec[]): McpInputRequiredDecision {
    return {
      kind: 'input_required',
      inputRequests: McpAskUserInputHandler.requestsOf(questions),
      state: { tool: this.toolName, ids: questions.map((question) => question.id) },
      reason: 'ask_user 需要用户回答',
    };
  }

  /**
   * 把一组问题转为 elicitation 输入请求。
   * @param questions 问题列表。
   * @returns 输入请求映射。
   */
  private static requestsOf(questions: readonly AskQuestionSpec[]): McpInputRequests {
    const requests: Record<string, McpInputRequestSpec> = {};
    for (const question of questions) {
      const enumValues =
        question.options === undefined || question.options.length === 0
          ? undefined
          : [...question.options];
      const answerSchema: Record<string, unknown> = {
        type: 'string',
        title: question.header ?? '回答',
        ...(enumValues !== undefined ? { enum: enumValues } : {}),
      };
      requests[question.id] = McpElicitation.request(
        question.header === undefined
          ? question.question
          : `${question.header}：${question.question}`,
        { answer: answerSchema },
        ['answer'],
      );
    }
    return requests;
  }

  /**
   * 从回答构造工具结果；缺答时重新请求缺失项。
   * @param questions 全部问题。
   * @param responses 客户端回答映射。
   * @returns `respond` 或再次 `input_required`。
   */
  private answer(
    questions: readonly AskQuestionSpec[],
    responses: McpInputResponses,
  ): McpInputRequiredDecision {
    const answers: Record<string, string> = {};
    const declined: string[] = [];
    const missing: AskQuestionSpec[] = [];
    for (const question of questions) {
      const raw = responses[question.id];
      if (raw === undefined) {
        missing.push(question);
        continue;
      }
      const parsed = McpElicitation.answerOf(raw);
      if (parsed.action !== 'accept') {
        declined.push(question.id);
        continue;
      }
      answers[question.id] = McpElicitation.stringOf(parsed, 'answer') ?? '';
    }
    if (missing.length > 0) {
      return {
        kind: 'input_required',
        inputRequests: McpAskUserInputHandler.requestsOf(missing),
        state: { tool: this.toolName, ids: questions.map((question) => question.id) },
        reason: `缺少 ${String(missing.length)} 个回答`,
      };
    }
    return {
      kind: 'respond',
      output: JSON.stringify({
        answers,
        ...(declined.length > 0 ? { declined } : {}),
      }),
    };
  }

  /**
   * 能力位是否按规范声明（对象才算）。
   * @param value 能力值。
   * @returns 已声明为 true。
   */
  private static capable(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * 从工具参数解析问题（非法输入返回 undefined，交回原工具报错）。
   * @param call 工具调用。
   * @returns 问题列表（id 已去重）。
   */
  private static questionsOf(call: ToolCall): readonly AskQuestionSpec[] | undefined {
    const raw = call.arguments['questions'];
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const seen = new Map<string, number>();
    const out: AskQuestionSpec[] = [];
    for (const [index, entry] of raw.entries()) {
      const record =
        typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
      const baseId =
        typeof record['id'] === 'string' && record['id'] !== ''
          ? record['id']
          : `q${String(index)}`;
      const count = seen.get(baseId) ?? 0;
      seen.set(baseId, count + 1);
      const id = count === 0 ? baseId : `${baseId}#${String(index)}`;
      const options = Array.isArray(record['options'])
        ? record['options']
            .map((option) =>
              typeof option === 'object' && option !== null
                ? (option as Record<string, unknown>)['label']
                : undefined,
            )
            .filter((label): label is string => typeof label === 'string' && label !== '')
        : undefined;
      out.push({
        id,
        question: typeof record['question'] === 'string' ? record['question'] : '',
        ...(typeof record['header'] === 'string' ? { header: record['header'] } : {}),
        ...(options !== undefined && options.length > 0 ? { options } : {}),
      });
    }
    return out;
  }
}
