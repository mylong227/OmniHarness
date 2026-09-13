import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';
import type { ModelPort } from '../../ports/model.js';
import { guardianPrompt } from './guardianPrompt.js';

/** Guardian 审批选项。 */
export interface GuardianApprovalOptions {
  /** 用于 LLM 审查的模型端口（预检未命中时调用）。 */
  readonly model: ModelPort;
  /** 明确危险的正则白名单（命中即 deny，不送 LLM）。 */
  readonly preDenyPatterns?: readonly RegExp[];
  /** 明确安全的正则白名单（命中即 allow，不送 LLM）。 */
  readonly preAllowPatterns?: readonly RegExp[];
}

/** Guardian 审批适配器：预检命中直判，未命中送 LLM 审查（移植 Codex guardian 思路，异常即拒绝）。 */
export class GuardianApproval implements ApprovalPort {
  /**
   * 审批器标识：固定为 'guardian'，用于区分送 LLM 审查的 Guardian 实现。
   */
  public readonly name = 'guardian';

  /** 预检 deny 正则集（命中即拒，省一次 LLM 调用）。 */
  private readonly preDenyPatterns: readonly RegExp[];
  /** 预检 allow 正则集（命中即放，省一次 LLM 调用）。 */
  private readonly preAllowPatterns: readonly RegExp[];

  /**
   * @param options Guardian 审批选项（模型端口与预检正则）。
   */
  public constructor(private readonly options: GuardianApprovalOptions) {
    this.preDenyPatterns = options.preDenyPatterns ?? [];
    this.preAllowPatterns = options.preAllowPatterns ?? [];
  }

  /** 裁决请求。
   * @param request 审批请求（工具名与目标）。
   * @returns 预检命中时的直判结果；否则 LLM 审查裁决（异常即 deny）。
   */
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const pre = this.preCheck(request.target);
    if (pre !== undefined) {
      return pre;
    }
    return this.askGuardian(request);
  }

  /** 预检：明确危险即拒，明确安全即放。
   * @param target 请求目标（命令/路径文本）。
   * @returns 命中预检正则时的直判；两者皆未命中为 undefined（转 LLM 审查）。
   */
  private preCheck(target: string): ApprovalDecision | undefined {
    if (this.preDenyPatterns.some((pattern) => pattern.test(target))) {
      return 'deny';
    }
    if (this.preAllowPatterns.some((pattern) => pattern.test(target))) {
      return 'allow';
    }
    return undefined;
  }

  /** 送 LLM 审查。
   * @param request 审批请求（构建提示词用）。
   * @returns LLM 给出的裁决；调用异常时 deny（fail-closed）。
   */
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

  /** 解析 LLM 裁决（无法识别即拒绝）。
   * @param text LLM 输出文本（可能为 undefined）。
   * @returns 'allow' 仅当文本明确含 allow；其余一律 'deny'。
   */
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
