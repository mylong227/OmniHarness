import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';

/** 自动放行审批适配器：默认允许一切（M0 兜底，生产请换策略/人工/LLM 审查）。 */
export class AutoApproval implements ApprovalPort {
  public readonly name = 'auto';

  /** 全部放行。 */
  public async decide(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return 'allow';
  }
}
