import type { ToolCall, ToolResult } from '../tool/tool.js';

/**
 * @beta
 * 工具门禁端口：审批 + 沙箱 + 计划态三道门禁统一裁决（fail-closed，任意拒绝即拦截）。
 *
 * 由 `core/toolGate.ts` 的 `ToolGate` 实现；MCP 服务端、组合根、子代理运行时等仅依赖本端口契约，
 * 不再反向依赖 core 层，从而解除 `ports→core` 的 `[3.5]` 禁边。
 */
export interface ToolGatePort {
  /**
   * 门禁检查：通过返回 undefined，否则返回带具体原因的拒绝结果。
   * @param call 待裁决的工具调用（名称 + 入参）。
   * @param sessionId 发起调用的会话 ID（审批/升级审批需要）。
   * @returns 拒绝时为带原因的失败 ToolResult；放行时为 undefined。
   */
  gate(call: ToolCall, sessionId: string): Promise<ToolResult | undefined>;
}
