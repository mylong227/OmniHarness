/**
 * 审批型工具的 MRTR live handler（2026-07-28）。
 *
 * 与 `ask_user` handler 同构：现代客户端（声明 `elicitation`）在调用受审批工具时先收到
 * `input_required`（allow/deny 二选一）；客户端回传 `ElicitResult` 后，本 handler 再经
 * {@link ApprovalPort} 做策略裁决（用户选择 × 策略，任一拒绝即拒绝），通过后才放行执行。
 *
 * legacy 客户端返回 `allow`，由既有 `ToolGate` 的审批路径处理（不破坏旧 stdio 行为）。
 */
import type { ToolCall } from '../ports/tool/tool.ts';
import type { ApprovalPort } from '../ports/runtime/approval.ts';
import type { McpInputRequests } from '../ports/mcp/mcpProtocolTypes.ts';
import type {
  McpInputRequiredContext,
  McpInputRequiredDecision,
  McpInputRequiredPort,
} from '../ports/mcp/mcpInputRequiredPort.ts';
import { McpElicitation } from './mcpElicitation.ts';

/** 审批 MRTR handler 选项。 */
export interface McpApprovalInputHandlerOptions {
  /** 需要走 MRTR 的工具名（缺省全部工具；给空数组表示不接管任何工具）。 */
  readonly toolNames?: readonly string[] | undefined;
  /** 每一步的说明文案（缺省按工具名生成）。 */
  readonly messageOf?: ((call: ToolCall) => string) | undefined;
}

/**
 * 审批型工具的 live handler（elicitation allow/deny + ApprovalPort 裁决）。
 */
export class McpApprovalInputHandler implements McpInputRequiredPort {
  /** 端口名。 */
  public readonly name = 'mcp-approval-input';
  /** 审批端口（策略裁决）。 */
  private readonly approval: ApprovalPort;
  /** 接管的工具名（undefined=全部）。 */
  private readonly toolNames: readonly string[] | undefined;
  /** 文案生成器。 */
  private readonly messageOf: (call: ToolCall) => string;

  /**
   * @param approval 审批端口（与本地 ToolGate 同一份策略）。
   * @param options 接管范围与文案。
   */
  public constructor(approval: ApprovalPort, options: McpApprovalInputHandlerOptions = {}) {
    this.approval = approval;
    this.toolNames = options.toolNames;
    this.messageOf =
      options.messageOf ?? ((call) => `工具 ${call.name} 需要人工审批；本次调用是否允许？`);
  }

  /**
   * 评估审批型调用。
   * @param context 调用与客户端能力/回答。
   * @returns allow/deny/input_required。
   */
  public async evaluate(context: McpInputRequiredContext): Promise<McpInputRequiredDecision> {
    if (!this.handles(context.call)) return { kind: 'allow' };
    if (!context.modern) return { kind: 'allow' };
    if (!McpApprovalInputHandler.capable(context.clientCapabilities.elicitation)) {
      return {
        kind: 'deny',
        message:
          '客户端未声明 elicitation 能力，审批无法按 MRTR 完成（fail-closed）；' +
          '请在 clientCapabilities 中声明 elicitation',
      };
    }
    if (context.inputResponses === undefined) {
      return this.ask(context.call);
    }
    return this.decide(context);
  }

  /**
   * 构造 allow/deny elicitation 请求。
   * @param call 工具调用。
   * @returns `input_required` 裁决。
   */
  private ask(call: ToolCall): McpInputRequiredDecision {
    const requests: McpInputRequests = {
      approval: McpElicitation.request(
        this.messageOf(call),
        {
          decision: {
            type: 'string',
            title: '审批结果',
            enum: ['allow', 'deny'],
          },
        },
        ['decision'],
      ),
    };
    return {
      kind: 'input_required',
      inputRequests: requests,
      state: { tool: call.name },
      reason: '审批型工具需要人工确认',
    };
  }

  /**
   * 处理客户端回答并做策略裁决。
   * @param context 重试上下文。
   * @returns allow 或 deny。
   */
  private async decide(context: McpInputRequiredContext): Promise<McpInputRequiredDecision> {
    const raw = context.inputResponses?.['approval'];
    const answer = McpElicitation.answerOf(raw);
    const choice = McpElicitation.stringOf(answer, 'decision');
    if (answer.action !== 'accept' || choice !== 'allow') {
      return { kind: 'deny', message: `用户未批准工具 ${context.call.name}（fail-closed）` };
    }
    const decision = await this.approval.decide({
      sessionId: context.sessionId,
      toolName: context.call.name,
      target: McpApprovalInputHandler.targetOf(context.call),
    });
    return decision === 'allow'
      ? { kind: 'allow' }
      : { kind: 'deny', message: `审批策略拒绝工具 ${context.call.name}（fail-closed）` };
  }

  /**
   * 该调用是否由本 handler 接管。
   * @param call 工具调用。
   * @returns 接管为 true。
   */
  private handles(call: ToolCall): boolean {
    return this.toolNames === undefined || this.toolNames.includes(call.name);
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
   * 从参数提取审批目标（路径/命令/URL；都没有时用工具名）。
   * @param call 工具调用。
   * @returns 目标字符串（截断，避免把大对象塞进审批记录）。
   */
  private static targetOf(call: ToolCall): string {
    for (const key of ['path', 'command', 'url', 'target']) {
      const value = call.arguments[key];
      if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 500);
    }
    return call.name;
  }
}
