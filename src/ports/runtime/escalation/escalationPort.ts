import type { EscalationRequest } from './escalationRequest.js';
import type { EscalationDecision } from './escalationDecision.js';

/** 升级审批端口：沙箱危险动作被拒时，裁决是否提权重试（fail-closed 由调用方保证）。 */
export interface EscalationPort {
  /** 端口名（用于可观测/调试）。 */
  readonly name: string;
  /** 裁决：escalate 提权重试，abort 终止。 */
  decide(request: EscalationRequest): Promise<EscalationDecision>;
}
