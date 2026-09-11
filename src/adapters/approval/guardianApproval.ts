import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';
import type { ModelPort } from '../../ports/model.js';
import { guardianPrompt } from './guardianPrompt.js';

/** Guardian 审批选项。 */
export interface GuardianApprovalOptions {
  readonly model: ModelPort;
  readonly preDenyPatterns?: readonly RegExp[];
  readonly preAllowPatterns?: readonly RegExp[];
}

/** Guardian 审批适配器：预检命中直判，未命中送 LLM 审查（移植 Codex guardian 思路，异常即拒绝）。 */
export class GuardianApproval implements ApprovalPort {
  public readonly name = 'guardian';

  private readonly preDenyPatterns: readonly RegExp[];
  private readonly preAllowPatterns: readonly RegExp[];

  public constructor(private readonly options: GuardianApprovalOptions) {
    this.preDenyPatterns = options.preDenyPatterns ?? [];
    this.preAllowPatterns = options.preAllowPatterns ?? [];
  }

  /** 裁决请求。 */
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const pre = this.preCheck(request.target);
    if (pre !== undefined) {
      return pre;
    }
    return this.askGuardian(request);
  }

  /** 预检：明确危险即拒，明确安全即放。 */
  private preCheck(target: string): ApprovalDecision | undefined {
    if (this.preDenyPatterns.some((pattern) => pattern.test(target))) {
      return 'deny';
    }
    if (this.preAllowPatterns.some((pattern) => pattern.test(target))) {
      return 'allow';
    }
    return undefined;
  }

  /** 送 LLM 审查。 */
  private async askGuardian(request: ApprovalRequest): Promise<ApprovalDecision> {
    try {
      const output = await this.options.model.generate({
        messages: guardianPrompt.build(request),
        tools: [],
      });
      return this.parseVerdict(output.text);
    } catch {
      return 'deny';
    }
  }

  /** 解析 LLM 裁决（无法识别即拒绝）。 */
  private parseVerdict(text: string | undefined): ApprovalDecision {
    if (text === undefined) {
      return 'deny';
    }
    if (/deny/i.test(text)) {
      return 'deny';
    }
    if (/allow/i.test(text)) {
      return 'allow';
    }
    return 'deny';
  }
}
