import type { ApprovalRequest } from '../../ports/runtime/approval.js';

/** Guardian 审查提示构建器：把审批请求转成 LLM 可判的提示词。 */
export class GuardianPrompt {
  /** 构建审查提示消息。
   * @param request 待审查的审批请求。
   * @returns 两条消息（system 规则 + user 请求描述）组成的消息数组。
   */
  public build(request: ApprovalRequest): { role: 'system' | 'user'; content: string }[] {
    return [
      { role: 'system', content: guardianPrompt.systemRule() },
      { role: 'user', content: guardianPrompt.requestText(request) },
    ];
  }

  /** 系统规则。
   * @returns 固定的系统提示词（只允许回答 allow/deny）。
   */
  private systemRule(): string {
    return '你是工具调用安全审查员。只回答 allow 或 deny，禁止其他内容。危险操作必须 deny。';
  }

  /** 请求描述。
   * @param request 审批请求。
   * @returns 面向 LLM 的请求文本（工具名 + 目标）。
   */
  private requestText(request: ApprovalRequest): string {
    return `工具: ${request.toolName}\n目标: ${request.target}`;
  }
}

/** 默认实例（无状态、可并发复用，调用点以 `guardianPrompt.xxx` 零构造复用）。 */
export const guardianPrompt = new GuardianPrompt();
