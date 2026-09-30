import type { ModelMessage } from './modelMessage.js';
import type { ModelToolSpec } from './modelToolSpec.js';

/** 模型请求。 */
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolSpec[];
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
   * 取消信号（V2，可选）：透传给底层 fetch 实现协作式取消。
   * 未提供时适配器行为不变（向后兼容）；提供时取消即中断在飞 HTTP 请求。
   */
  readonly signal?: AbortSignal | undefined;
}
