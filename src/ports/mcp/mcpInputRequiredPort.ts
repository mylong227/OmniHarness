import type { ToolCall } from '../tool/tool.ts';
import type {
  McpClientCapabilities,
  McpInputRequests,
  McpInputResponses,
} from './mcpProtocolTypes.ts';

/**
 * @beta
 * 服务端「需要更多输入」评估上下文（MRTR，2026-07-28）。
 *
 * 每次 `tools/call` 都会先经 live handler 评估：首次调用没有 `inputResponses`；
 * 客户端带 `inputResponses` + `requestState` 重试时，`attempt >= 1` 且两者会被填入。
 * 实现必须**无连接状态**（规范要求协议无状态）；跨调用信息只能放进 `requestState`。
 */
export interface McpInputRequiredContext {
  /** 待执行的工具调用（重试时与首次调用逐字一致；服务端已校验摘要）。 */
  readonly call: ToolCall;
  /** harness 会话 id。 */
  readonly sessionId: string;
  /** 第几次尝试（0 = 首次）。 */
  readonly attempt: number;
  /** 客户端声明的能力（未声明时为空对象；实现不得假设未声明的能力）。 */
  readonly clientCapabilities: McpClientCapabilities;
  /** 是否为 2026-07-28 现代请求（legacy 请求没有每请求能力，实现应回落旧行为）。 */
  readonly modern: boolean;
  /** 客户端回传的输入回答（仅重试时存在）。 */
  readonly inputResponses?: McpInputResponses | undefined;
  /** 服务端在上一次 `input_required` 中密封的状态（已验签/验期；仅重试时存在）。 */
  readonly state?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * @beta
 * live handler 的裁决。
 *
 * - `allow`：无需输入，继续走门禁 + 执行；
 * - `deny`：fail-closed，直接作为 `isError` 工具结果返回；
 * - `respond`：不执行工具，直接把该输出作为工具结果（`ask_user` 回答型工具用）；
 * - `input_required`：返回 MRTR 中间结果，等客户端带回答重试。
 */
export type McpInputRequiredDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly message: string }
  | { readonly kind: 'respond'; readonly output: string; readonly isError?: boolean }
  | {
      readonly kind: 'input_required';
      /** 需要客户端补充的输入（键为服务端分配的稳定 id）。 */
      readonly inputRequests: McpInputRequests;
      /** 服务端不透明状态（会被 HMAC 密封后进行 `requestState`，不得放 secret）。 */
      readonly state?: Readonly<Record<string, unknown>> | undefined;
      /** 人类可读原因（只进日志/诊断，不直接进错误消息）。 */
      readonly reason?: string | undefined;
    };

/**
 * @beta
 * 服务端 MRTR live handler 端口（审批 / `ask_user` / 其它需要人机的工具）。
 *
 * ## fail-closed 语义
 *
 * - 客户端未声明所需能力（如 `elicitation`）时，服务端**拒绝**发 `input_required`
 *   （规范：MUST NOT 发送客户端未声明支持的请求），返回 `-32021`；
 * - legacy（无每请求 `_meta`）客户端没有能力声明位，handler 应返回 `allow` 让旧路径继续，
 *   或返回 `deny`；**不得**对 legacy 客户端发 MRTR；
 * - 没有注入本端口时服务端完全不产生 `input_required`（旧行为零变化）。
 */
export interface McpInputRequiredPort {
  /** 端口名（日志/诊断用）。 */
  readonly name: string;

  /**
   * 评估一次工具调用是否需要额外输入。
   * @param context 调用、能力与重试回答。
   * @returns 裁决（allow / deny / respond / input_required）。
   */
  evaluate(context: McpInputRequiredContext): Promise<McpInputRequiredDecision>;
}
