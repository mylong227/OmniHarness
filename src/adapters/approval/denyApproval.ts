import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';

/** 拒绝型审批适配器：拒绝一切工具调用（演示 fail-closed 策略）。 */
export class DenyApproval implements ApprovalPort {
  public readonly name = 'deny';

  /** 全部拒绝。 */
  public async decide(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return 'deny';
  }
}
