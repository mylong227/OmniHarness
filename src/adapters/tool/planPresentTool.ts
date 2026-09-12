import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { PlanPort } from '../../ports/plan.js';
import type { EventPort } from '../../ports/eventPort.js';
import type { UserResponder } from '../../ports/userResponder.js';
import type { EventFactoryPort } from '../../ports/eventFactory.js';

/**
 * @beta
 * `plan_present`：把计划呈现给用户并等待审批结论（approve/reject）。
 * 这是计划协作态的"出口"——批准前 ToolGate 拦截所有 mutating 工具。
 */
export class PlanPresentTool {
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
