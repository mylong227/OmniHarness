import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { PlanPort } from '../../ports/plan.js';

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
