import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { PlanDraft, PlanPort, PlanStep } from '../../../ports/runtime/plan.js';
import type { EventPort } from '../../../ports/runtime/eventPort.js';
import type { EventFactoryPort } from '../../../ports/runtime/eventFactory.js';

/**
 * @beta
 * `plan_write`：写入/更新计划草稿（重新起草回到 drafting，需再次呈现审批）。
 * 对标 dsh `packages/plan/plan-mode`。
 */
export class PlanWriteTool {
  /**
   * 工具定义：plan_write 工具的名称、描述与参数 schema。
   * 计划模式下全量替换草稿，起草完成后须经 plan_present 审批方可执行写类工具。
   */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.planWrite,
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
    private readonly events: EventPort | undefined,
    private readonly eventFactory: EventFactoryPort,
  ) {}

  /**
   * 执行 plan_write：校验并写入有序步骤，广播 plan 事件，回到 drafting 态。
   * @param call 模型传入的工具调用（含 steps 与可选 title）。
   * @param ctx 工具执行上下文（取 sessionId 用于广播 plan 事件）。
   * @returns steps 非数组/空或描述为空时报错；成功返回起草步数与状态提示。
   */
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
    const state = this.plan.get();
    this.events?.emit(this.eventFactory.plan(ctx.sessionId, state));
    // 如实回报**实际**状态（2026-09-26 审计 F14）：步骤集合未变时已批准的计划会保持 approved
    // （否则「汇报进度」这一步会把写类工具重新锁死），此时不该再谎称「状态 drafting」。
    const status = state?.status ?? 'drafting';
    const hint =
      status === 'approved'
        ? '计划已批准且步骤未变，保持批准态（可直接继续执行；改步骤集合才需要重新呈现审批）。'
        : '用 plan_present 呈现审批。';
    return {
      callId: call.id,
      ok: true,
      output: `计划已起草（${String(steps.length)} 步，状态 ${status}）；${hint}`,
    };
  }
}
