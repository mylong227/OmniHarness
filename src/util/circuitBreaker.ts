import { CircuitOpenError } from '../errors/circuitOpenError.js';

/**
 * 熔断器状态：`closed` 正常放行 / `open` 开路快速失败 / `half-open` 半开探测。
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * 熔断器选项（均可省略，取保守默认值）。
 */
export interface CircuitBreakerOptions {
  /** 连续失败达此数即开路，默认 5（保守：正常抖动不会触发）。 */
  readonly failureThreshold?: number;
  /** 开路冷却毫秒：期间一律快速失败，到期自动转半开，默认 30000。 */
  readonly openMs?: number;
  /** 半开状态放行的并发探测数，默认 1（探测全成功才复位）。 */
  readonly halfOpenMaxProbes?: number;
  /** 时钟注入（默认 `Date.now`）；测试必须注入假时钟，禁止真实睡眠。 */
  readonly now?: () => number;
  /** 状态变更回调（可选）：供上层上报/日志/UI 展示熔断跳变。 */
  readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * 熔断状态快照（只读，供上报与断言）。
 */
export interface CircuitSnapshot {
  /** 当前状态（快照前已按冷却窗口惰性推进）。 */
  readonly state: CircuitState;
  /** closed 状态下的连续失败计数。 */
  readonly failures: number;
  /** 开路起点毫秒时间戳；非 open 状态为 undefined。 */
  readonly openedAt: number | undefined;
  /** 半开状态已放行但未返回的探测数。 */
  readonly halfOpenInFlight: number;
  /** 半开状态已成功的探测数（达 halfOpenMaxProbes 即复位）。 */
  readonly halfOpenSuccesses: number;
}

/** 默认连续失败阈值。 */
const DEFAULT_FAILURE_THRESHOLD = 5;
/** 默认开路冷却毫秒。 */
const DEFAULT_OPEN_MS = 30_000;
/** 默认半开并发探测数。 */
const DEFAULT_HALF_OPEN_MAX_PROBES = 1;

/**
 * 通用故障熔断器（F3，标准三态状态机，零依赖）。
 *
 * 语义：**保护下游**——当某条依赖连续失败达阈值时立即开路，冷却期内对该依赖的调用
 * 一律快速失败（不发起真实调用、不等待超时、不消耗重试预算），冷却到期后进入半开：
 * 放行少量探测，探测成功即复位为 closed，探测失败则重新开路。
 *
 * 与重试的分工（务必保持这个顺序）：
 *  - 重试处理**单次调用内的瞬时抖动**（指数退避，见 `util/retry.ts` / `RetryingModel`）；
 *  - 熔断处理**跨调用的持续不可用**（本类）。
 *  因此熔断器应包在重试**外层**：一次逻辑调用（含其内部全部重试）才算一次熔断计数，
 *  避免单次请求的多次重试就把熔断器打跳闸。
 *
 * 与成本熔断（`BudgetExceededError`）无关：那是"别花钱"，本类是"别打已经挂掉的下游"。
 *
 * 说明：`CircuitBreaker` 是电子工程/软件可靠性领域的**标准模式名**（Nygard《Release It!》），
 * 非物理定律隐喻，故不适用 `@maturity` 声明。
 */
export class CircuitBreaker {
  /** 熔断器名（上报与错误信息用，如 `model`）。 */
  public readonly name: string;

  /** 连续失败阈值：closed 下达到即开路。 */
  private readonly failureThreshold: number;
  /** 开路冷却毫秒。 */
  private readonly openMs: number;
  /** 半开并发探测上限。 */
  private readonly halfOpenMaxProbes: number;
  /** 时钟（注入以便测试推进冷却窗口）。 */
  private readonly now: () => number;
  /** 状态变更回调（可选）。 */
  private readonly onStateChange: ((from: CircuitState, to: CircuitState) => void) | undefined;

  /** 当前状态。 */
  private state: CircuitState = 'closed';
  /** closed 下的连续失败计数。 */
  private failures = 0;
  /** 开路起点时间戳（冷却计算基准）。 */
  private openedAt: number | undefined;
  /** 半开已放行未返回的探测数。 */
  private halfOpenInFlight = 0;
  /** 半开已成功的探测数。 */
  private halfOpenSuccesses = 0;

  /**
   * @param name 熔断器名（用于错误信息与上报定位）。
   * @param options 熔断参数（阈值/冷却/半开探测数/时钟/回调）。
   */
  public constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.openMs = options.openMs ?? DEFAULT_OPEN_MS;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? DEFAULT_HALF_OPEN_MAX_PROBES;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  /** 当前状态（读取前按冷却窗口惰性推进：冷却到期的 open 自动转 half-open）。
   * @returns 推进后的状态。
   */
  public get currentState(): CircuitState {
    this.advance();
    return this.state;
  }

  /**
   * 申请一次调用许可（有副作用：半开状态下会占用一个探测名额）。
   * @returns 放行返回 true；开路冷却期内或半开探测名额已满返回 false。
   */
  public allowRequest(): boolean {
    this.advance();
    if (this.state === 'closed') {
      return true;
    }
    if (this.state === 'open') {
      return false;
    }
    if (this.halfOpenInFlight < this.halfOpenMaxProbes) {
      this.halfOpenInFlight += 1;
      return true;
    }
    return false;
  }

  /** 记录一次成功：closed 清零连续失败；half-open 累计探测成功，达上限即复位为 closed。
   * @returns 无返回值。
   */
  public recordSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.halfOpenMaxProbes) {
        this.transition('closed');
      }
      return;
    }
    // closed（或防御性地在 open 上收到成功）：清零失败计数。
    this.failures = 0;
    if (this.state === 'open') {
      this.transition('closed');
    }
  }

  /** 记录一次失败：closed 累计到达阈值即开路；half-open 任一探测失败立即重新开路。
   * @returns 无返回值。
   */
  public recordFailure(): void {
    if (this.state === 'half-open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.transition('open');
      return;
    }
    if (this.state === 'open') {
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.transition('open');
    }
  }

  /**
   * 在熔断保护下执行一次调用：不允许则抛 `CircuitOpenError`（fail-closed，不执行 `fn`）；
   * 允许则执行并按结果记账（成功复位/失败累计）。
   * @param fn 单次调用的异步操作（已在内部完成重试的"逻辑调用"）。
   * @returns `fn` 的解析值（成功时）。
   * @throws CircuitOpenError 熔断器拒绝调用（开路冷却中或半开探测名额已满）。
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.allowRequest()) {
      const openedAt = this.openedAt ?? this.now();
      throw new CircuitOpenError(`熔断器 "${this.name}" 已开路，本次调用被拒绝（fail-closed）`, {
        breaker: this.name,
        openedAt,
        retryAfterMs: Math.max(0, openedAt + this.openMs - this.now()),
      });
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /** 取当前状态快照（读取前同样惰性推进冷却窗口）。
   * @returns 只读快照（状态/失败数/开路时刻/半开计数）。
   */
  public snapshot(): CircuitSnapshot {
    this.advance();
    return {
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt,
      halfOpenInFlight: this.halfOpenInFlight,
      halfOpenSuccesses: this.halfOpenSuccesses,
    };
  }

  /** 手动复位为 closed（管理动作/测试用），清零全部计数。
   * @returns 无返回值。
   */
  public reset(): void {
    this.failures = 0;
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
    this.transition('closed');
  }

  /** 冷却窗口到期则把 open 推进为 half-open（重置半开计数）。无到期则不动。
   * @returns 无返回值。
   */
  private advance(): void {
    if (this.state !== 'open' || this.openedAt === undefined) {
      return;
    }
    if (this.now() - this.openedAt >= this.openMs) {
      this.transition('half-open');
    }
  }

  /** 执行状态跳变并按目标状态重置相关计数，最后触发回调。
   * @param to 目标状态（与当前相同时直接返回，不触发回调）。
   * @returns 无返回值。
   */
  private transition(to: CircuitState): void {
    if (to === this.state) {
      return;
    }
    const from = this.state;
    this.state = to;
    if (to === 'open') {
      this.openedAt = this.now();
      this.halfOpenInFlight = 0;
      this.halfOpenSuccesses = 0;
    } else {
      this.openedAt = undefined;
      if (to === 'closed') {
        this.failures = 0;
        this.halfOpenInFlight = 0;
        this.halfOpenSuccesses = 0;
      } else {
        // half-open：进入时重置探测计数，保留 failures 供诊断。
        this.halfOpenInFlight = 0;
        this.halfOpenSuccesses = 0;
      }
    }
    this.onStateChange?.(from, to);
  }
}
