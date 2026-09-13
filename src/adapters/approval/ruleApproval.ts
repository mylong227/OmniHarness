import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../ports/runtime/approval.js';
import type { ApprovalRule, ApprovalRuleDecision } from './approvalRule.js';
import { commandGlob, type CommandGlob } from './commandGlob.js';

/** 规则审批选项。 */
export interface RuleApprovalOptions {
  /** 有序规则集：全部命中规则参与决策聚合（deny 优先 → ask → allow）。 */
  readonly rules: readonly ApprovalRule[];
  /** 规则未覆盖请求时的默认决策（缺省 'deny'，fail-closed）。 */
  readonly defaultDecision?: ApprovalRuleDecision;
  /** 'ask' 命中时的回调（交互确认）；未提供则按 deny 处理。 */
  readonly askHandler?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** glob 匹配器（缺省用无状态单例；注入点便于测试与替换实现）。 */
  readonly glob?: CommandGlob;
}

/** 规则审批适配器：deny 优先 → ask 次之 → allow → 默认决策（缺省 deny，fail-closed）。 */
export class RuleApproval implements ApprovalPort {
  /**
   * 审批器标识：固定为 'rules'，用于区分基于规则集的审批实现。
   */
  public readonly name = 'rules';

  /** 规则未覆盖时的默认决策（构造时解析，缺省 deny）。 */
  private readonly defaultDecision: ApprovalRuleDecision;
  /** 'ask' 命中时的交互回调；未提供则 ask 一律拒绝。 */
  private readonly askHandler?:
    ((request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;
  /** 命令 glob 匹配器（用于 `commandGlob` 规则约束）。 */
  private readonly glob: CommandGlob;

  /**
   * @param options 规则审批选项（规则集、默认决策、ask 回调与 glob 匹配器）。
   */
  public constructor(private readonly options: RuleApprovalOptions) {
    // fail-closed：未显式配置 defaultDecision 时，规则未覆盖的请求一律拒绝，而非默认放行。
    this.defaultDecision = options.defaultDecision ?? 'deny';
    this.askHandler = options.askHandler;
    this.glob = options.glob ?? commandGlob;
  }

  /** 裁决请求。
   * @param request 审批请求（工具名、目标等）。
   * @returns 聚合裁决：deny 优先，其次 ask，再次 allow，否则默认决策。
   */
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
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

  /** 默认决策解析（ask 需走回调）。
   * @param request 审批请求（ask 回调需要）。
   * @returns 默认决策；默认决策为 ask 时转交回调（无回调则 deny）。
   */
  private async resolveDefault(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.defaultDecision === 'ask') {
      return this.ask(request);
    }
    return this.defaultDecision;
  }

  /** 命中规则的决策集合。
   * @param request 审批请求。
   * @returns 全部命中规则的决策数组（保留规则顺序，供 deny/ask/allow 聚合）。
   */
  private matchingDecisions(request: ApprovalRequest): ApprovalRuleDecision[] {
    return this.options.rules
      .filter((rule) => this.matches(rule, request))
      .map((rule) => rule.decision);
  }

  /** 规则是否匹配请求。
   * @param rule 待检验的审批规则。
   * @param request 审批请求。
   * @returns 工具名、命令前缀与命令 glob 条件均满足（未声明的条件跳过）为 true。
   */
  private matches(rule: ApprovalRule, request: ApprovalRequest): boolean {
    if (rule.toolName !== undefined && rule.toolName !== request.toolName) {
      return false;
    }
    if (rule.commandPrefix !== undefined && !request.target.startsWith(rule.commandPrefix)) {
      return false;
    }
    if (rule.commandGlob !== undefined && !this.glob.matches(rule.commandGlob, request.target)) {
      return false;
    }
    return true;
  }

  /** ask 裁决：有回调走回调，无回调默认拒绝（安全）。
   * @param request 审批请求（透传给回调）。
   * @returns 回调给出的裁决；无回调时为 'deny'。
   */
  private async ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.askHandler !== undefined) {
      return this.askHandler(request);
    }
    return 'deny';
  }
}
