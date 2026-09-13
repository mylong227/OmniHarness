/** 升级裁决：被沙箱/审批拒绝后，是否申请提权重试。 */
export type EscalationDecision = 'escalate' | 'abort';

/** 拒绝来源（当前仅 sandbox 触发升级；审批策略拒绝不升级，避免绕过既定策略）。 */
export type EscalationDeniedBy = 'sandbox' | 'approval';

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

/** 升级审批端口：沙箱危险动作被拒时，裁决是否提权重试（fail-closed 由调用方保证）。 */
export interface EscalationPort {
  /** 端口名（用于可观测/调试）。 */
  readonly name: string;
  /** 裁决：escalate 提权重试，abort 终止。 */
  decide(request: EscalationRequest): Promise<EscalationDecision>;
}
