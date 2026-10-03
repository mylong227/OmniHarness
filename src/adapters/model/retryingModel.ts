import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  StreamCallbacks,
} from '../../ports/model/model.js';
import { ModelCallError } from '../../ports/model/model.js';

/**
 * @beta
 * 重试策略（#M6，对标 codex `RetryPolicy`）。
 */
export interface RetryPolicy {
  /** 最大尝试次数（含首次），默认 3。 */
  readonly maxAttempts: number;
  /** 基础退避毫秒，默认 500。第 n 次尝试前等待 ≈ base·2^(n-1)。 */
  readonly baseDelayMs: number;
  /** 单次等待上限毫秒，默认 15000（防止指数爆炸）。 */
  readonly maxDelayMs: number;
  /** 抖动幅度（0~1），实际等待 = 指数值 × (1 ± jitter)；默认 0.1（±10%）。 */
  readonly jitter: number;
}

/**
 * @beta
 * 默认重试策略。
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitter: 0.1,
};

/**
 * @beta
 * 可注入的等待函数（测试用 no-op 避免真实休眠）。
 */
export type DelayFn = (ms: number) => Promise<void>;

/**
 * @beta
 * 模型调用重试装饰器（#M6，对标 codex `retry.rs` / `responses_retry.rs`）。
 *
 * 把任意 `ModelPort` 包一层：可重试错误（429/408/5xx/网络抖动）按指数退避 + 抖动重试，
 * 尊重服务端 Retry-After；不可重试错误（4xx 客户端错误）或达到最大次数后直接上抛。
 * 对上层完全透明——`name`/`generate`/`stream` 行为与内部模型一致。
 */
export class RetryingModel implements ModelPort {
  /** 适配器名（端口契约），透传内部模型的 name，对上层完全透明。 */
  public readonly name: string;

  /**
   * 流式生成：仅当内部模型真的具备 stream 能力时才定义（V2.1 修复）。
   * 之前实现为类方法恒存在——对无 stream 的内部模型（如 mock）虚假广告，
   * 调用时返回 undefined，上层 StepRunner 拿到 undefined 直接炸
   * 「Cannot read properties of undefined (reading 'reasoning')」。
   * modelRetry 默认开（A3）后该缺陷在 headless 路径必然触发，故必须修。
   */
  public readonly stream?: (
    request: ModelRequest,
    callbacks: StreamCallbacks,
  ) => Promise<ModelOutput>;

  public constructor(
    /** 被装饰的底层模型端口（generate/stream 都经它执行）。 */
    private readonly inner: ModelPort,
    /** 重试策略（尝试次数、退避与抖动参数）。 */
    private readonly policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    /** 等待函数（生产为真实 setTimeout，测试可注入 no-op）。 */
    private readonly delay: DelayFn = RetryingModel.realDelay,
  ) {
    this.name = inner.name;
    if (inner.stream !== undefined) {
      const innerStream = inner.stream.bind(inner);
      // 流式重试语义（2026-10-03 审计 D4 权衡后**保留重试**）：首次尝试已向 live sink
      // 投递过增量（onText/onToolInput）再失败时，重试会让终端出现「前缀 + 全文」的重复
      // 显示——但这是 **--stream-text 观感缺陷**；核心循环只消费最终完整输出（stepRunner
      // 在 await 之后才记录 assistant 事件），改 fail-fast 会把「可恢复的瞬态断流」升级成
      // 整回合硬失败，能力上是净倒退。故重试语义不变，观感代价如实登记于此。
      this.stream = (request, callbacks) =>
        this.run(() => innerStream(request, callbacks), request.signal);
    }
  }

  /** 生成响应（带重试）。
   * @param request 模型请求（原样透传给内部模型）。
   * @returns 首次成功的输出；不可重试错误或达到最大尝试次数后上抛最后一个错误。
   */
  public generate(request: ModelRequest): Promise<ModelOutput> {
    return this.run(() => this.inner.generate(request), request.signal);
  }

  /** 执行 + 重试主循环。
   * @param fn 单次尝试的异步操作（generate 或 stream 的包装）。
   * @param signal 可选取消信号：尝试间与退避等待期间检查（2026-10-03 修，审计 D10——
   *   旧实现退避等待不可取消，用户按「停止」后仍要睡满 Retry-After/指数退避窗口）。
   * @returns 首次成功的结果；不可重试或次数耗尽时抛出最后捕获的错误。
   */
  private async run(fn: () => Promise<ModelOutput>, signal?: AbortSignal): Promise<ModelOutput> {
    let attempt = 0;
    let lastError: unknown = new Error('unreachable');
    while (true) {
      attempt += 1;
      RetryingModel.assertNotAborted(signal);
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= this.policy.maxAttempts || !RetryingModel.isRetryable(err)) {
          break;
        }
        await this.waitBackoff(err, attempt, signal);
      }
    }
    throw lastError;
  }

  /**
   * 退避等待（可取消）：等待期间信号置位即提前返回，下一轮循环的 assertNotAborted
   * 会以 AbortError 终止——「停止」在退避窗口内也即时生效。
   * @param err 刚捕获的错误（决定 Retry-After 优先的等待时长）。
   * @param attempt 即将进行的尝试序号。
   * @param signal 可选取消信号。
   * @returns 等待结束（自然到期或被取消）后的 Promise。
   */
  private async waitBackoff(err: unknown, attempt: number, signal?: AbortSignal): Promise<void> {
    const ms = this.delayFor(err, attempt);
    if (signal === undefined) {
      await this.delay(ms);
      return;
    }
    await Promise.race([
      this.delay(ms),
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
  }

  /**
   * 信号已置位即抛 AbortError（不再发起新尝试；用户取消不是模型健康度事件）。
   * @param signal 可选取消信号。
   * @returns 无返回值；已取消时抛出。
   */
  private static assertNotAborted(signal?: AbortSignal): void {
    if (signal !== undefined && signal.aborted) {
      const abort = new Error('模型调用已被取消（重试前检查到 AbortSignal 已置位）');
      abort.name = 'AbortError';
      throw abort;
    }
  }

  /** 计算本次等待毫秒：优先采用 Retry-After，否则指数退避 × 抖动，封顶 maxDelayMs。
   * @param err 刚捕获的错误（可能是 ModelCallError，带服务端 Retry-After）。
   * @param attempt 即将进行的尝试序号（从 1 起，决定指数底数）。
   * @returns 本次重试前应等待的毫秒数。
   */
  private delayFor(err: unknown, attempt: number): number {
    if (err instanceof ModelCallError && err.retryAfterMs !== undefined) {
      return Math.min(this.policy.maxDelayMs, err.retryAfterMs);
    }
    const exp = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (attempt - 1));
    const jitter = 1 + (Math.random() * 2 - 1) * this.policy.jitter;
    return Math.min(this.policy.maxDelayMs, Math.round(exp * jitter));
  }
  /**
   * realDelay — module-level helper moved into RetryingModel.
   */
  private static realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * @beta
   * 错误可重试性判定（#M6）。
   * 优先级：`ModelCallError.retryable` > 显式 `retryable` 标记 > HTTP 状态码 > 网络码/消息。
   * 兼容不抛 `ModelCallError` 的模型端口（duck-typing 兜底）。
   * @param err 待判定的错误（任意抛出值）。
   * @returns 是否值得重试（429/408/409/5xx、显式 retryable 标记或网络类错误码/消息）。
   */
  public static isRetryable(err: unknown): boolean {
    if (err instanceof ModelCallError) {
      return err.retryable;
    }
    const e = err as {
      readonly status?: number;
      readonly retryable?: boolean;
      readonly code?: string;
      readonly message?: string;
    };
    if (e.retryable === true) {
      return true;
    }
    if (e.retryable === false) {
      return false;
    }
    if (typeof e.status === 'number') {
      return (
        e.status === 429 ||
        e.status === 408 ||
        e.status === 409 ||
        (e.status >= 500 && e.status <= 599)
      );
    }
    const code = e.code;
    if (typeof code === 'string') {
      return [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ECONNABORTED',
        'EPIPE',
        'UND_ERR_SOCKET',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(code);
    }
    // 消息兜底：`terminated` 是 **undici/fetch 在连接被中途掐断**（server 提前关闭 socket）时的标准错误文本，
    // 属典型瞬时网络故障，但 2026-09-26 实测它**不在**原正则里 ⇒ `isRetryable` 判 false ⇒ 不重试 ⇒
    // 一次网络抖动就**白丢一整题**（并白花该题已消耗的 token；付费批次实测 20 题里出现 4 次）。
    // 同族文本一并收录：`socket hang up`（Node http 客户端）、`other side closed`（undici 的 cause）。
    const message = typeof e.message === 'string' ? e.message : '';
    return /fetch failed|network|timeout|econnreset|terminated|socket hang up|other side closed|premature close/i.test(
      message,
    );
  }
}
