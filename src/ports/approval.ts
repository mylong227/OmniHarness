/** 审批决定。 */
export type ApprovalDecision = 'allow' | 'deny';

/** 审批请求。 */
export interface ApprovalRequest {
  readonly sessionId: string;
  readonly toolName: string;
  readonly target: string;
}

/** 审批端口：人工/策略/LLM 审查的统一插口（fail-closed 由调用方保证）。 */
export interface ApprovalPort {
  readonly name: string;
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}
