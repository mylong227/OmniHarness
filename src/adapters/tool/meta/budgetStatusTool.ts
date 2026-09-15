import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { CostBudget } from '../../model/costBudget.js';

/**
 * 成本预算状态工具（#S29 / P5）：让模型随时自查当前花费 / 剩余 / token 累计 / 缓存折抵 /
 * 是否已熔断 / 是否已触及软阈值（建议降级），便于在临近硬预算时主动收敛（少调用、精简输出），
 * 而不是被 `BudgetExceededError` 硬断。仅当配置了 `costBudgetUsd` 时注册。
 */
export class BudgetStatusTool {
  /**
   * 工具定义：budget_status 工具的名称、描述与参数 schema。
   * 让模型自查当前成本预算（上限/已花费/剩余/token/缓存折抵/软硬阈值），临近上限时主动收敛用量。
   */
  public readonly definition: ToolDefinition = {
    name: 'budget_status',
    description:
      '查询本次会话的模型调用成本预算状态：硬预算上限（USD）、已花费、剩余、输入/输出 token 累计、' +
      '命中提示缓存折抵的金额、软阈值（建议降级）与是否已熔断。' +
      'degradeSuggested 为 true 时表示已接近上限，应主动收敛用量（少调用、精简输出、缩小检索范围）。',
    parameters: {
      type: 'object',
      properties: {},
    },
  };

  /**
   * @param budget 成本预算端口（快照只读，不产生调用花费）。
   */
  public constructor(private readonly budget: CostBudget) {}

  /** 返回当前预算快照。
   * @param call 工具调用（本工具无参数）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：JSON 文本含上限/已花费/剩余/token 累计/缓存折抵/软硬阈值。
   */
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
          cachedPromptTokens: snap.cachedPromptTokens,
          savedUsd: Number(snap.savedUsd.toFixed(6)),
          softLimitUsd: Number(snap.softLimitUsd.toFixed(6)),
          softExceeded: snap.softExceeded,
          degradeSuggested: snap.degradeSuggested,
          exceeded: snap.exceeded,
        },
        null,
        2,
      ),
    };
  }
}
