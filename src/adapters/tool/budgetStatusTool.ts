import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { CostBudget } from '../model/costBudget.js';

/**
 * 成本预算状态工具（#S29）：让模型随时自查当前花费 / 剩余 / token 累计 / 是否已熔断，
 * 便于在临近硬预算时主动收敛（少调用、精简输出），而不是被 `BudgetExceededError` 硬断。
 * 仅当配置了 `costBudgetUsd` 时注册。
 */
export class BudgetStatusTool {
  public readonly definition: ToolDefinition = {
    name: 'budget_status',
    description:
      '查询本次会话的模型调用成本预算状态：硬预算上限（USD）、已花费、剩余、输入/输出 token 累计、是否已熔断。临近上限时据此主动收敛用量，避免被硬预算阻断。',
    parameters: {
      type: 'object',
      properties: {},
    },
  };

  public constructor(private readonly budget: CostBudget) {}

  /** 返回当前预算快照。 */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const snap = this.budget.snapshot();
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify(
        {
          limitUsd: snap.limitUsd,
          spentUsd: Number(snap.spentUsd.toFixed(6)),
          remainingUsd: Number(snap.remainingUsd.toFixed(6)),
          totalPromptTokens: snap.totalPromptTokens,
          totalCompletionTokens: snap.totalCompletionTokens,
          exceeded: snap.exceeded,
        },
        null,
        2,
      ),
    };
  }
}
