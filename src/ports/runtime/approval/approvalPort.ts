import type { ApprovalDecision } from './approvalDecision.js';
import type { ApprovalRequest } from './approvalRequest.js';

/** 审批端口：人工/策略/LLM 审查的统一插口（fail-closed 由调用方保证）。 */
export interface ApprovalPort {
  readonly name: string;
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}
