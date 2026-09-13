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
    name: 'plan_present',
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
