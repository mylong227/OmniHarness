import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';

/** 自动放行审批适配器：默认允许一切（M0 兜底，生产请换策略/人工/LLM 审查）。 */
export class AutoApproval implements ApprovalPort {
  /**
   * 审批器标识：固定为 'auto'，用于日志/分组区分自动放行兜底实现。
   */
  public readonly name = 'auto';

  /** 全部放行。 */
  public async decide(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return 'allow';
  }
}
