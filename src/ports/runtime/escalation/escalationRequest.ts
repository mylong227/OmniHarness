import type { EscalationDeniedBy } from './escalationDeniedBy.js';

/** 升级审批请求：携带被拒动作与原因，供裁决器判断是否可提权重试。 */
export interface EscalationRequest {
  /** 会话 ID。 */
  readonly sessionId: string;
  /** 被拒工具名。 */
  readonly toolName: string;
  /** 动作目标（命令/路径）。 */
  readonly target: string;
  /** 拒绝原因（来自 SandboxDecision.reason 或审批端口）。 */
  readonly reason: string;
  /** 拒绝来源：sandbox 才走升级路径。 */
  readonly deniedBy: EscalationDeniedBy;
}
