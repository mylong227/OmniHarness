/** 审批请求。 */
export interface ApprovalRequest {
  readonly sessionId: string;
  readonly toolName: string;
  readonly target: string;
}
