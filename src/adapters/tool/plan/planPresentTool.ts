import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { PlanPort } from '../../../ports/runtime/plan.js';
import type { EventPort } from '../../../ports/runtime/eventPort.js';
import type { UserResponder } from '../../../ports/runtime/userResponder.js';
import type { EventFactoryPort } from '../../../ports/runtime/eventFactory.js';

/**
 * @beta
 * `plan_present`：把计划呈现给用户并等待审批结论（approve/reject）。
 * 这是计划协作态的"出口"——批准前 ToolGate 拦截所有 mutating 工具。
 */
export class PlanPresentTool {
  /**
   * 工具定义：plan_present 工具的名称、描述与参数 schema。
   * 将当前计划呈现给用户审批，批准前 ToolGate 拦截所有 mutating 工具。
   */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.planPresent,
    description:
      '呈现当前计划给用户审批。返回 approve 或 reject；approve 后计划门禁解除，方可执行写类工具。',
    parameters: { type: 'object', properties: {} },
  };

  public constructor(
    private readonly plan: PlanPort,
    private readonly responder: UserResponder,
    private readonly events: EventPort | undefined,
    private readonly eventFactory: EventFactoryPort,
  ) {}

  /**
   * 执行 plan_present：呈现计划、征求 approve/reject 并据答复推进计划态。
   * @param call 模型传入的工具调用（本工具无参数）。
   * @param ctx 工具执行上下文（取 sessionId 用于广播 plan 事件）。
   * @returns 批准则解除门禁；无计划或回答缺失返回 ok:false；驳回给出重新规划提示。
   */
  public async handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const current = this.plan.get();
    if (current === null) {
      return { callId: call.id, ok: false, error: '尚无计划可呈现，请先用 plan_write 起草' };
    }
    this.plan.present();
    this.events?.emit(this.eventFactory.plan(ctx.sessionId, this.plan.get()));
    const answers = await this.responder.ask([
      {
        id: 'plan_decision',
        header: '计划审批',
        question: '是否批准以上计划开始执行？',
        options: [
          { label: 'approve', description: '批准并执行' },
          { label: 'reject', description: '驳回，重新规划' },
        ],
      },
    ]);
    const answer = answers[0];
    if (answer === undefined) {
      return { callId: call.id, ok: false, error: '用户回答缺失' };
    }
    // 无人值守（`DefaultUserResponder` 等）返回**空 selected + 说明**：这不是「用户驳回」，
    // 而是「根本没拿到用户意见」。旧实现把它一律当成 reject 并 `plan.decide('reject')` ——
    // 在非 TTY 的 Web/serve/子代/eval 里，计划模式就此**永久锁死**（ToolGate 对写类工具恒拒），
    // 且回报文案还谎称「用户驳回了计划」（2026-09-26 审计 F6）。
    // 正确处置：不改计划状态、如实说明无法取得审批，让模型自行分支（改走 ask_user 或直接说明）。
    const decided = answer.selected.some((label) => label === 'approve' || label === 'reject');
    if (!decided) {
      return {
        callId: call.id,
        ok: false,
        error:
          '无法取得计划审批：当前运行环境没有可交互的用户（未拿到 approve/reject）。' +
          '计划状态保持不变；请改用 ask_user 说明情况，或直接按最小可行步骤推进。',
      };
    }
    const decision: 'approve' | 'reject' = answer.selected.includes('approve')
      ? 'approve'
      : 'reject';
    this.plan.decide(decision);
    this.events?.emit(this.eventFactory.plan(ctx.sessionId, this.plan.get()));
    return {
      callId: call.id,
      ok: true,
      output: decision === 'approve' ? '计划已批准，开始执行。' : '计划被驳回，请重新规划。',
    };
  }
}
