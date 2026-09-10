import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { EventPort } from '../../ports/eventPort.js';
import type { PlanDraft, PlanPort, PlanStep } from '../../ports/plan.js';
import type { UserResponder } from '../../ports/userResponder.js';
import { EventFactory } from '../../core/eventFactory.js';

/**
 * @beta
 * `plan_write`：写入/更新计划草稿（重新起草回到 drafting，需再次呈现审批）。
 * 对标 dsh `packages/plan/plan-mode`。
 */
export class PlanWriteTool {
  public readonly definition: ToolDefinition = {
    name: 'plan_write',
    description:
      '在计划模式下起草/更新计划：传入有序 steps。每次调用全量替换当前草稿。' +
      '起草完成后用 plan_present 呈现给用户审批，批准前不可执行写类工具。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '计划标题（可选）' },
        steps: {
          type: 'array',
          description: '有序步骤列表',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: '这一步要做什么' },
              status: { type: 'string', description: 'pending | done（可选）' },
            },
          },
        },
      },
      required: ['steps'],
    },
  };

  public constructor(
    private readonly plan: PlanPort,
    private readonly events?: EventPort,
  ) {}

  public async handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const raw = call.arguments['steps'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return { callId: call.id, ok: false, error: 'steps 必须是非空数组' };
    }
    const steps: PlanStep[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const e = raw[i] as Record<string, unknown>;
      const description = typeof e['description'] === 'string' ? (e['description'] as string) : '';
      if (description.length === 0) {
        return { callId: call.id, ok: false, error: `steps[${i}].description 不能为空` };
      }
      const step: PlanStep =
        e['status'] === 'done' || e['status'] === 'pending'
          ? { description, status: e['status'] }
          : { description };
      steps.push(step);
    }
    const draft: PlanDraft =
      typeof call.arguments['title'] === 'string'
        ? { title: call.arguments['title'] as string, steps }
        : { steps };
    this.plan.write(draft);
    this.events?.emit(EventFactory.plan(ctx.sessionId, this.plan.get()));
    return {
      callId: call.id,
      ok: true,
      output: `计划已起草（${steps.length} 步，状态 drafting）；用 plan_present 呈现审批。`,
    };
  }
}

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
    private readonly events?: EventPort,
  ) {}

  public async handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const current = this.plan.get();
    if (current === null) {
      return { callId: call.id, ok: false, error: '尚无计划可呈现，请先用 plan_write 起草' };
    }
    this.plan.present();
    this.events?.emit(EventFactory.plan(ctx.sessionId, this.plan.get()));
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
    this.events?.emit(EventFactory.plan(ctx.sessionId, this.plan.get()));
    return {
      callId: call.id,
      ok: true,
      output: decision === 'approve' ? '计划已批准，开始执行。' : '计划被驳回，请重新规划。',
    };
  }
}

/**
 * @beta
 * `plan_read`：读取当前计划态快照。
 */
export class PlanReadTool {
  public readonly definition: ToolDefinition = {
    name: 'plan_read',
    description: '读取当前计划草稿与审批状态。',
    parameters: { type: 'object', properties: {} },
  };

  public constructor(private readonly plan: PlanPort) {}

  public async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const state = this.plan.get();
    if (state === null) {
      return { callId: call.id, ok: true, output: '(尚无计划)' };
    }
    return { callId: call.id, ok: true, output: JSON.stringify(state) };
  }
}
