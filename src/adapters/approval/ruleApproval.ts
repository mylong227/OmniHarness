import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';
import type { ApprovalRule, ApprovalRuleDecision } from './approvalRule.js';

/** 规则审批选项。 */
export interface RuleApprovalOptions {
  readonly rules: readonly ApprovalRule[];
  readonly defaultDecision?: ApprovalRuleDecision;
  readonly askHandler?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

/** 规则审批适配器：deny 优先 → ask 次之 → allow → 默认决策（缺省 deny，fail-closed）。 */
export class RuleApproval implements ApprovalPort {
  readonly name = 'rules';

  private readonly defaultDecision: ApprovalRuleDecision;
  private readonly askHandler?: (request: ApprovalRequest) => Promise<ApprovalDecision>;

  constructor(private readonly options: RuleApprovalOptions) {
    // fail-closed：未显式配置 defaultDecision 时，规则未覆盖的请求一律拒绝，而非默认放行。
    this.defaultDecision = options.defaultDecision ?? 'deny';
    this.askHandler = options.askHandler;
  }

  /** 裁决请求。 */
  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decisions = this.matchingDecisions(request);
    if (decisions.includes('deny')) {
      return 'deny';
    }
    if (decisions.includes('ask')) {
      return this.ask(request);
    }
    if (decisions.includes('allow')) {
      return 'allow';
    }
    return this.resolveDefault(request);
  }

  /** 默认决策解析（ask 需走回调）。 */
  private async resolveDefault(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.defaultDecision === 'ask') {
      return this.ask(request);
    }
    return this.defaultDecision;
  }

  /** 命中规则的决策集合。 */
  private matchingDecisions(request: ApprovalRequest): ApprovalRuleDecision[] {
    return this.options.rules
      .filter((rule) => this.matches(rule, request))
      .map((rule) => rule.decision);
  }

  /** 规则是否匹配请求。 */
  private matches(rule: ApprovalRule, request: ApprovalRequest): boolean {
    if (rule.toolName !== undefined && rule.toolName !== request.toolName) {
      return false;
    }
    if (rule.commandPrefix !== undefined && !request.target.startsWith(rule.commandPrefix)) {
      return false;
    }
    return true;
  }

  /** ask 裁决：有回调走回调，无回调默认拒绝（安全）。 */
  private async ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.askHandler !== undefined) {
      return this.askHandler(request);
    }
    return 'deny';
  }
}
