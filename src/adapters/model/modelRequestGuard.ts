/**
 * 模型请求的**空闲超时**统一装配（单一口径）。
 *
 * 存在理由（2026-09-26 稳定性审计 S2）：`RequestStallGuard` 早已落地，但只接在
 * `OpenAiCompatibleModel` 一条路上——Anthropic / Responses / llama.cpp 三个适配器仍是**裸 `fetch`**。
 * 服务端接受 TCP 后不回包时 `fetch` 永不 settle（既不 resolve 也不 reject），调用方又没有取消令牌
 * 时整条 agent 循环**无限期挂死**，且 `RetryingModel` 只对「抛出的」错误重试 ⇒ 永不触发。
 *
 * 本类把「解析阈值 → 为单次请求开守卫 → 把空闲超时归类为可重试错误」收成一处，
 * 四个适配器共用同一份语义（此前是每个适配器各写一遍，漏一个就是一条挂死路径）。
 *
 * 语义是**空闲**（idle）而非**总时限**：计时从请求发出起算，每收到一次数据（响应头 / SSE 事件块）
 * 即重置 —— 「慢但有进展」的长推理不会被误杀，只有「连续静默超过阈值」才中止。
 */

import type { ModelRequest } from '../../ports/model/model.js';
import { ModelCallError } from '../../ports/model/model.js';
import { RequestStallGuard } from './requestStallGuard.js';

/** 库级默认的模型请求**空闲**超时（毫秒）：连续 5 分钟无任何数据即中止；`<=0` 表示关闭。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** 覆盖库级默认空闲超时的环境变量名（取值须为有限数字；`0` 或负数表示关闭空闲超时）。 */
export const REQUEST_TIMEOUT_ENV_KEY = 'OMNI_MODEL_REQUEST_TIMEOUT_MS';

/**
 * 单次模型请求的守卫装配器（无状态判定 + 每请求一个新守卫）。
 *
 * 每个适配器持有一个实例（构造期解析一次阈值），生命周期方法都在**请求**粒度上调用。
 */
export class ModelRequestGuard {
  /** 生效的请求空闲超时（毫秒，`<=0` 表示关闭空闲超时，此时只在有调用方信号时才开守卫）。 */
  public readonly timeoutMs: number;

  /**
   * @param explicit 适配器配置显式给出的空闲超时（毫秒，可选）；缺省读环境变量再回落库级默认。
   */
  public constructor(explicit?: number) {
    this.timeoutMs = ModelRequestGuard.resolveTimeoutMs(explicit);
  }

  /**
   * 为单次请求开守卫。既无空闲超时又无调用方信号时返回 `undefined` —— 此时**完全不传 signal**，
   * 与加守卫之前逐字一致（零行为变更）。
   * @param request 模型请求（其 `signal` 被转发进守卫，取消语义与改造前同）。
   * @returns 该请求专属的守卫；无需守卫时为 `undefined`。
   */
  public open(request: ModelRequest): RequestStallGuard | undefined {
    if (this.timeoutMs <= 0 && request.signal === undefined) {
      return undefined;
    }
    return new RequestStallGuard(this.timeoutMs, request.signal);
  }

  /**
   * 把「空闲超时」收敛为**可重试**的结构化错误；其余错误原样返回。
   *
   * 关键区分：`guard.timedOut` 为假即中止来自**调用方取消**（上层意图），必须原样上抛。
   * 已是 `ModelCallError` 的错误（如 HTTP 4xx/5xx）不覆盖：结构化错误信息量更大，不该被超时顶掉。
   * @param err fetch / 解析阶段抛出的原始错误。
   * @param guard 本次请求的守卫（可为 `undefined`）。
   * @param label 错误消息前缀（区分普通生成与流式生成两条路径）。
   * @returns 可重试的 `ModelCallError`（空闲超时）或原始错误。
   */
  public wrap(err: unknown, guard: RequestStallGuard | undefined, label: string): unknown {
    if (guard === undefined || !guard.timedOut || err instanceof ModelCallError) {
      return err;
    }
    return new ModelCallError(`${label}超时：连续 ${this.timeoutMs}ms 无响应`, {
      retryable: true,
    });
  }

  /**
   * 解析生效的请求空闲超时：显式配置 > 环境变量 > 库级默认。
   * 环境变量为空串或非有限数字时回落库级默认 —— 不静默变成 `NaN`（否则 `idleMs > 0` 判据会被
   * NaN 击穿，等于静默关掉整个守卫）。
   * @param explicit 调用方显式给出的值（可选）。
   * @returns 生效的空闲超时毫秒数；`<=0` 语义为关闭空闲超时。
   */
  public static resolveTimeoutMs(explicit?: number): number {
    if (explicit !== undefined) {
      return explicit;
    }
    const raw = process.env[REQUEST_TIMEOUT_ENV_KEY];
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
}
