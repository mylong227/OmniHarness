/**
 * MRTR live handler 组合器（2026-07-28）。
 *
 * 多个 handler 按注册顺序评估；第一个给出非 `allow` 裁决的 handler 获胜。
 * 用途：`mcp serve` 可同时挂 `ask_user` 与审批 handler，而互不覆盖。
 */
import type {
  McpInputRequiredContext,
  McpInputRequiredDecision,
  McpInputRequiredPort,
} from '../ports/mcp/mcpInputRequiredPort.ts';

/**
 * 依次评估多个 MRTR live handler。
 */
export class McpCompositeInputHandler implements McpInputRequiredPort {
  /** 端口名。 */
  public readonly name = 'mcp-composite-input';
  /** 子 handler（按顺序）。 */
  private readonly handlers: readonly McpInputRequiredPort[];

  /**
   * @param handlers 子 handler 列表（空列表等价于「不产生 input_required」）。
   */
  public constructor(handlers: readonly McpInputRequiredPort[]) {
    this.handlers = [...handlers];
  }

  /**
   * 依次评估，返回第一个非 allow 裁决。
   * @param context 调用上下文。
   * @returns 裁决（全部 allow 时为 allow）。
   */
  public async evaluate(context: McpInputRequiredContext): Promise<McpInputRequiredDecision> {
    for (const handler of this.handlers) {
      const decision = await handler.evaluate(context);
      if (decision.kind !== 'allow') return decision;
    }
    return { kind: 'allow' };
  }
}
