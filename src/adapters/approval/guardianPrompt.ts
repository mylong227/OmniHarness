import type { ApprovalRequest } from '../../ports/approval.js';

/** Guardian 审查提示构建器：把审批请求转成 LLM 可判的提示词。 */
export class GuardianPrompt {
  /** 构建审查提示消息。 */
  public static build(request: ApprovalRequest): { role: 'system' | 'user'; content: string }[] {
    return [
      { role: 'system', content: GuardianPrompt.systemRule() },
      { role: 'user', content: GuardianPrompt.requestText(request) },
    ];
  }

  /** 系统规则。 */
  private static systemRule(): string {
    return '你是工具调用安全审查员。只回答 allow 或 deny，禁止其他内容。危险操作必须 deny。';
  }

  /** 请求描述。 */
  private static requestText(request: ApprovalRequest): string {
    return `工具: ${request.toolName}\n目标: ${request.target}`;
  }
}
