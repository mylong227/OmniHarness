/**
 * MRTR `elicitation/create` 的构造与解析（2026-07-28）。
 *
 * 只做**形状**：构造 form 模式请求、从 `inputResponses` 的 `ElicitResult` 里取动作/答案。
 * 不决定业务语义（由 ask_user / 审批 handler 决定）。
 */
import type { McpInputRequestSpec } from '../ports/mcp/mcpProtocolTypes.ts';

/** 规范化后的 elicitation 结果。 */
export interface McpElicitationAnswer {
  /** 用户动作。 */
  readonly action: 'accept' | 'decline' | 'cancel' | 'unknown';
  /** 表单内容（accept 时存在）。 */
  readonly content: Readonly<Record<string, unknown>>;
}

/**
 * elicitation 形状工具。
 */
export class McpElicitation {
  /**
   * 构造一条 `elicitation/create` 输入请求。
   * @param message 展示给用户的说明。
   * @param properties 顶层字段 schema（只允许 primitive，符合规范）。
   * @param required 必填字段。
   * @returns 输入请求。
   */
  public static request(
    message: string,
    properties: Readonly<Record<string, unknown>>,
    required: readonly string[] = [],
  ): McpInputRequestSpec {
    return {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: { ...properties },
          required: [...required],
        },
      },
    };
  }

  /**
   * 解析客户端回传的 `ElicitResult`。
   * @param raw 原始回答（未知形状）。
   * @returns 规范化结果（非法形状收敛为 `unknown` + 空内容）。
   */
  public static answerOf(raw: unknown): McpElicitationAnswer {
    if (typeof raw !== 'object' || raw === null) {
      return { action: 'unknown', content: {} };
    }
    const record = raw as Record<string, unknown>;
    const action =
      record['action'] === 'accept' ||
      record['action'] === 'decline' ||
      record['action'] === 'cancel'
        ? record['action']
        : 'unknown';
    const content =
      typeof record['content'] === 'object' && record['content'] !== null
        ? (record['content'] as Record<string, unknown>)
        : {};
    return { action, content };
  }

  /**
   * 取某个字段的字符串答案。
   * @param answer 规范化结果。
   * @param field 字段名。
   * @returns 非空字符串；缺失/类型不符为 undefined。
   */
  public static stringOf(answer: McpElicitationAnswer, field: string): string | undefined {
    const value = answer.content[field];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }
}
