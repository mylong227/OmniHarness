import type { ModelMessage } from './modelMessage.ts';
import type { ModelResponseFormat } from './modelResponseFormat.ts';
import type { ModelToolSpec } from './modelToolSpec.ts';
import type { ModelRole } from './modelRole.ts';

/** 模型请求。 */
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolSpec[];
  /** 角色（可选，P1-4）：`by-role` 路由按它选模型；未设/未映射时回退第一 entry。 */
  readonly role?: ModelRole | undefined;
  /**
   * 结构化输出意图（可选，2026-10-11）：缺省＝纯文本（与旧行为逐字一致）。
   *
   * 各适配器把它落到各自上游的正确字段（见 {@link ModelResponseFormat} 的形态表）；
   * Anthropic 无原生字段，用「单工具强制」等价实现。
   */
  readonly responseFormat?: ModelResponseFormat | undefined;
  /** 推理强度（可选，#B6）：透传为 OpenAI reasoning_effort 等，未设则后端按模型默认。 */
  readonly reasoningEffort?: string | undefined;
  /**
   * 采样温度（可选）：透传为 OpenAI 兼容端点的 `temperature`，未设则后端按模型默认。
   *
   * 为什么需要：基准/回归场景要求**同输入同输出**，否则「同一实例两次跑出不同补丁」会让
   * A/B 差异被采样噪声淹没（2026-09-17 实测：同一题在温度默认下先 resolved 后失败）。
   * 显式传 0 即得贪婪解码，使「省 token 的形态切换是否伤解题率」这一对照可复现。
   */
  readonly temperature?: number | undefined;
  /**
   * 单次响应输出上限（可选，2026-10-20）：透传为 OpenAI `max_tokens` / Anthropic `max_tokens`。
   * 未设 = 端点默认。用于给长会话一个成本上界（例如 16k），避免一次思考生成 20k token。
   */
  readonly maxOutputTokens?: number | undefined;
  /**
   * 取消信号（V2，可选）：透传给底层 fetch 实现协作式取消。
   * 未提供时适配器行为不变（向后兼容）；提供时取消即中断在飞 HTTP 请求。
   */
  readonly signal?: AbortSignal | undefined;
}
