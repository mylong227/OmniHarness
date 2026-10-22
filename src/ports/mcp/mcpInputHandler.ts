/**
 * @beta
 * MCP MRTR（Multi-Round Tool Request）的客户端输入回路。
 *
 * 2026-07-28 规范把 server 发起的 elicitation/sampling/roots 收口为
 * `resultType:"input_required"` + `inputRequests`；client 必须带 `inputResponses` 重试。
 * 本端口只表达「把一组输入请求交给宿主回答」——具体是 UI 弹窗、CLI 提示还是脚本回答，
 * 由实现决定；没有实现时客户端 fail-closed（拒绝，不猜测、不自动填空）。
 */
export interface McpInputRequest {
  /** 请求标识（server 给的 id；缺失时由客户端按顺序生成）。 */
  readonly id: string;
  /** 人类可读提示（若 server 提供）。 */
  readonly prompt?: string | undefined;
  /** 原始请求（保留未知字段，便于 UI 渲染或审计）。 */
  readonly raw: unknown;
}

/** 一条输入回答（id 必须对应请求）。 */
export interface McpInputResponse {
  /** 对应 {@link McpInputRequest.id}。 */
  readonly id: string;
  /** 回答值（字符串/布尔/对象均可，由 server 的 schema 决定）。 */
  readonly value: unknown;
}

/** 输入回路端口。 */
export interface McpInputHandler {
  /**
   * 回答一组输入请求。
   * @param requests 请求列表（非空）。
   * @returns 回答列表；缺失的请求由客户端视为未回答并 fail-closed。
   */
  resolve(requests: readonly McpInputRequest[]): Promise<readonly McpInputResponse[]>;
}
