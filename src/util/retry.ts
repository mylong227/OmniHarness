/**
 * 通用重试原语（零依赖）。
 *
 * 提供指数退避 + 全抖动 + 可重试判定的 `withRetry`，供所有出网/易失败操作复用
 * （模型请求、provider 探针、A2A 传输、外部 HTTP），避免各模块重复发明重试逻辑。
 */

/** 重试选项。 */
export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3。 */
  readonly maxAttempts?: number;
  /** 基础退避毫秒，默认 200。 */
  readonly baseDelayMs?: number;
  /** 最大退避毫秒，默认 5000。 */
  readonly maxDelayMs?: number;
  /** 退避因子，默认 2（指数）。 */
  readonly factor?: number;
  /** 可重试判定：返回 true 才重试；缺省对所有错误重试（最后一次仍失败则抛出）。 */
  readonly isRetryable?: (error: unknown) => boolean;
  /** 每次尝试前的等待钩子（注入测试时钟）。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 退避计算所需参数（不含 maxAttempts，该字段与退避无关）。 */
export interface BackoffParams {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

/** 计算第 n 次失败后的退避（指数 + 全抖动），封顶 maxDelayMs。 */
export function backoffMs(attempt: number, opts: BackoffParams): number {
  const raw = opts.baseDelayMs * Math.pow(opts.factor, attempt - 1);
  const capped = Math.min(raw, opts.maxDelayMs);
  // 全抖动：[0, capped] 均匀随机，避免重试风暴共振。
  return Math.random() * capped;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 对 `fn` 施加重试。所有尝试失败则抛出最后一次错误。
 * fail-closed：非可重试错误立即抛出，不浪费重试预算。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = {
    maxAttempts: options.maxAttempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 200,
    maxDelayMs: options.maxDelayMs ?? 5000,
    factor: options.factor ?? 2,
  };
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= opts.maxAttempts || !isRetryable(error)) {
        throw error;
      }
      const delay = backoffMs(attempt, opts);
      await sleep(delay);
    }
  }
  throw lastError;
}
