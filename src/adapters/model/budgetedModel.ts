import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model/model.ts';
import type { CostBudget } from './costBudget.ts';
import { TokenEstimator } from '../../context/tokenEstimator.ts';
import { log } from '../../util/logger.ts';

/**
 * @beta
 * 成本预算装饰器（#S29）：fail-closed 包裹任意 `ModelPort`。
 *
 * - 调用前 `ensureWithin` 校验预算：已熔断则抛 `BudgetExceededError`，阻断支出；
 * - 调用成功后按返回的 `usage` 记账；**端点未回传 usage 时按本地 token 估算记账**并给
 *   `usage.estimated=true`（2026-10-21）。旧行为是直接不记账——预算显示 $0、硬熔断永不触发，
 *   比“估算”更危险；估算误差由该标记显式暴露，读方不得把它当精确值。
 *
 * 与 `RetryingModel` 串联时置于**外层**（先判预算再重试），确保重试不致重复记账，
 * 且预算熔断优先于重试退避（熔断后不再发起任何网络调用）。
 */
export class BudgetedModel implements ModelPort {
  /** 装饰后模型名称（透传内部模型名）。 */
  public readonly name: string;
  /** 缺 usage 时的本地估算器（仅预算记账用，不影响上下文预算）。 */
  private readonly estimator = new TokenEstimator();

  public constructor(
    private readonly inner: ModelPort,
    private readonly budget: CostBudget,
  ) {
    this.name = inner.name;
  }

  /**
   * 生成（预算熔断优先）：调用前校验预算、成功后按 usage 记账（缺 usage 用估算）。
   * @param request 模型请求
   * @returns 模型输出（含 usage 供记账）
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.budget.ensureWithin(this.inner.name);
    const out = await this.inner.generate(request);
    return this.account(request, out);
  }

  /**
   * 流式生成（预算熔断优先）：无原生 stream 时回退 generate 并记账。
   * @param request   模型请求
   * @param callbacks 流式回调
   * @returns 模型输出（含 usage 供记账）
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    this.budget.ensureWithin(this.inner.name);
    const out =
      this.inner.stream !== undefined
        ? await this.inner.stream(request, callbacks)
        : await this.inner.generate(request);
    return this.account(request, out);
  }

  /**
   * 记账并把估算出的 usage 附加回输出（让上层事件/UI 也能看到 estimated 标记）。
   * @param request 本次请求。
   * @param out 模型输出。
   * @returns 带 usage 的输出（原样 usage 优先）。
   */
  private account(request: ModelRequest, out: ModelOutput): ModelOutput {
    const usage = out.usage ?? this.estimate(request, out);
    this.budget.record(this.inner.name, usage);
    if (out.usage === undefined) {
      log.warn('model.usage.estimated', {
        model: this.inner.name,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
      return { ...out, usage };
    }
    return out;
  }

  /**
   * 本地 token 估算（粗粒度，仅用于成本预算兜底）。
   * @param request 本次请求（message 正文 + 工具调用参数字节）。
   * @param out 模型输出。
   * @returns 标记 estimated 的用量。
   */
  private estimate(request: ModelRequest, out: ModelOutput): ModelUsage {
    const promptTokens = this.estimator.estimateMessages(request.messages);
    const completionText = `${out.text ?? ''}${
      out.toolCalls === undefined ? '' : JSON.stringify(out.toolCalls)
    }`;
    const completionTokens = this.estimator.estimate(completionText);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: true,
    };
  }
}
