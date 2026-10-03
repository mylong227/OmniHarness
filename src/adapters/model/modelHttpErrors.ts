import { ModelCallError } from '../../errors/modelCallError.js';
import { log } from '../../util/logger.js';

/**
 * 非流式/流式 HTTP 错误 → 结构化 `ModelCallError` 的共享映射器（2026-10-03 修，审计 D1/D3）。
 *
 * 为什么必须有它：`RetryingModel.isRetryable` 的分类依据是错误的 `status` / `retryable` /
 * `retryAfterMs` 结构化字段；此前 Anthropic / Responses 适配器抛的是裸 `Error`（消息里虽然
 * 带着 `HTTP 429`，但不参与判定）⇒ 429 限流、529 过载、5xx 瞬态故障**一次都不重试**直接炸掉
 * 整个回合，而熔断器照常计数——重试层缺席、熔断层在场，组合行为完全错位。
 * OpenAI 兼容适配器已有等价实现（`httpError`），本类把它抽成跨协议共享，新协议接入即得正确分类。
 */
export class ModelHttpErrors {
  /**
   * HTTP 状态码是否可重试（与 `RetryingModel.isRetryable` 的状态码口径一致）。
   * @param status HTTP 状态码。
   * @returns 429/408/409/5xx 时 true。
   */
  public static retryableOf(status: number): boolean {
    return status === 429 || status === 408 || status === 409 || (status >= 500 && status <= 599);
  }

  /**
   * 解析 `Retry-After` 头（秒数或 HTTP 日期两种形态）为毫秒。
   * @param header Retry-After 头原值。
   * @returns 建议等待毫秒数（≥0）；无法解析时 undefined。
   */
  public static parseRetryAfter(header: string): number | undefined {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    const at = Date.parse(header);
    if (!Number.isNaN(at)) {
      return Math.max(0, at - Date.now());
    }
    return undefined;
  }

  /**
   * 把非 2xx 响应转为结构化错误（消费响应体以便连接复用，并把 body 摘要落日志）。
   * @param response fetch 返回的非 2xx 响应。
   * @param label 错误消息前缀（区分生成/流式与协议）。
   * @returns 携带 status / retryable / retryAfterMs 的结构化模型调用错误（不抛出，由调用方决定）。
   */
  public static async from(response: Response, label: string): Promise<ModelCallError> {
    const status = response.status;
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs =
      retryAfter === null ? undefined : ModelHttpErrors.parseRetryAfter(retryAfter);
    // 非 2xx 时消费掉响应体：既留下可定位的真实原因，也避免连接因 body 未读而无法复用。
    const bodyText = await response.text().catch(() => '<unreadable>');
    log.error('model.http.error', { status, label, body: bodyText.slice(0, 2000) });
    return new ModelCallError(`${label}: HTTP ${status}`, {
      status,
      retryable: ModelHttpErrors.retryableOf(status),
      retryAfterMs,
    });
  }

  /**
   * 把流中 `error` 事件负载转为结构化错误（审计 D3：流中错误此前被静默丢弃，
   * 半截文本/半截工具参数会被当成成功输出）。
   * @param provider 协议/厂商名（错误消息归因）。
   * @param errorType 上游错误类型（如 Anthropic 的 `overloaded_error`）。
   * @param message 上游错误消息。
   * @returns 按类型映射伪状态码的结构化错误（overloaded→529、rate limit→429、timeout→504）。
   */
  public static streamError(provider: string, errorType: string, message: string): ModelCallError {
    const status = /overloaded/i.test(errorType)
      ? 529
      : /rate.?limit/i.test(errorType)
        ? 429
        : /timeout/i.test(errorType)
          ? 504
          : 500;
    return new ModelCallError(
      `${provider} 流中错误: ${errorType}${message === '' ? '' : `: ${message}`}`,
      {
        status,
        retryable: ModelHttpErrors.retryableOf(status),
      },
    );
  }
}
