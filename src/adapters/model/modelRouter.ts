import type {
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
  StreamCallbacks,
} from '../../ports/model/model.js';
import { at } from '../../util/arrayAt.js';

/** 路由条目：一个底层模型适配器 + 其标识与定价。 */
export interface RouterEntry {
  /** 底层模型适配器（真正执行 generate/stream 的对象）。 */
  readonly adapter: ModelPort;
  /** 该 entry 的模型标识（记账与日志按键）。 */
  readonly model: string;
  /** 每 1k token 的输入/输出单价（USD）；缺省时 least-cost 策略无法对该模型计价。 */
  readonly pricing?: { readonly inputPer1k: number; readonly outputPer1k: number } | undefined;
}

/** 路由策略。 */
export type RouterStrategy = 'least-cost' | 'round-robin' | 'by-task' | 'health-fallback';

/** ModelRouter 构造参数。 */
export interface ModelRouterOptions {
  /** 候选底层模型列表（至少一项，空则构造即抛错）。 */
  readonly entries: readonly RouterEntry[];
  /** 路由策略：最低成本 / 轮询 / 按任务关键词 / 健康度降级。 */
  readonly strategy: RouterStrategy;
  /** by-task 策略下，仅在该 role 的消息中匹配关键词（缺省匹配全部消息）。 */
  readonly taskField?: string | undefined;
}

/** 「写/实现」类任务关键词（不区分大小写）。 */
const BY_TASK_CODE_PATTERN = /代码|实现|写|code|implement/i;
/** 「推理/分析」类任务关键词（不区分大小写）。 */
const BY_TASK_REASON_PATTERN = /推理|分析|为什么|reason|analyze/i;

/**
 * 智能模型路由：对外表现为单一 ModelPort（实现 generate / 可选的 stream），
 * 按策略把请求转发到 entries 中的某个底层适配器。
 *
 * fail-closed：entry 为空、策略非法、或 health-fallback 全失败时一律安全报错，不静默放行。
 */
export class ModelRouter implements ModelPort {
  /** 适配器名，与端口契约一致：固定为 'model-router'。 */
  public readonly name = 'model-router';

  /** 轮询游标。 */
  private cursor = 0;
  /** 各模型累计成本（USD），least-cost 用。 */
  private readonly spend: Map<string, number> = new Map();

  public constructor(
    /** 路由配置：候选模型与选择策略（entries 为空时构造抛错）。 */
    private readonly options: ModelRouterOptions,
  ) {
    if (options.entries.length === 0) {
      throw new Error('ModelRouter 需要至少一个 entry（fail-closed）');
    }
  }

  /** 生成响应：按策略选择底层适配器并转发，成功后记账。
   * @param request 模型请求（原样透传给选中的适配器）。
   * @returns 底层适配器的输出；health-fallback 策略下依次降级，全失败时抛最后一个错误。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    if (this.options.strategy === 'health-fallback') {
      return this.generateWithFallback(request);
    }
    const entry = this.pick(request);
    const output = await entry.adapter.generate(request);
    this.recordUsage(
      entry.model,
      output.usage?.promptTokens ?? 0,
      output.usage?.completionTokens ?? 0,
    );
    return output;
  }

  /** 流式生成：转发到选中适配器（其不支持 stream 时 fail-closed 报错）。
   * @param request 模型请求（原样透传给选中的适配器）。
   * @param callbacks 流式回调集合（原样透传，增量不经路由器加工）。
   * @returns 流结束后的底层适配器输出；完成后按 usage 记账。选中适配器不支持流式时同步抛错。
   */
  public stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const entry = this.pick(request);
    const adapter = entry.adapter;
    if (adapter.stream === undefined) {
      throw new Error(`ModelRouter 选中的 adapter "${entry.model}" 不支持 stream（fail-closed）`);
    }
    return adapter.stream(request, callbacks).then((output) => {
      this.recordUsage(
        entry.model,
        output.usage?.promptTokens ?? 0,
        output.usage?.completionTokens ?? 0,
      );
      return output;
    });
  }

  /** 按策略选出底层 entry（entry 非空，下标必然有效）。
   * @param request 模型请求（by-task 策略需要读消息内容匹配关键词）。
   * @returns 选中的路由条目。
   */
  private pick(request: ModelRequest): RouterEntry {
    return at(this.options.entries, this.select(request));
  }

  /** health-fallback：依次尝试 entries，某 adapter 抛错则下一个；全失败才抛（fail-closed）。
   * @param request 模型请求（逐个适配器重试同一请求）。
   * @returns 首个成功适配器的输出；全部失败时抛出最后一个错误（非 Error 则包装）。
   */
  private async generateWithFallback(request: ModelRequest): Promise<ModelOutput> {
    let lastError: unknown;
    for (const entry of this.options.entries) {
      try {
        const output = await entry.adapter.generate(request);
        this.recordUsage(
          entry.model,
          output.usage?.promptTokens ?? 0,
          output.usage?.completionTokens ?? 0,
        );
        return output;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('ModelRouter 所有 entry 均失败（fail-closed）');
  }

  /** 内部记账：按 pricing 估算并累加某模型成本（least-cost 用）。
   * @param model 模型标识（需与某 entry 的 model 一致才找得到定价，否则记 0）。
   * @param promptTokens 本次调用的输入 token 数。
   * @param completionTokens 本次调用的输出 token 数。
   
 * @returns 无返回值。
*/
  public recordUsage(model: string, promptTokens: number, completionTokens: number): void {
    const entry = this.options.entries.find((entry) => entry.model === model);
    const pricing = entry?.pricing;
    const cost =
      pricing === undefined
        ? 0
        : (promptTokens / 1000) * pricing.inputPer1k +
          (completionTokens / 1000) * pricing.outputPer1k;
    this.spend.set(model, (this.spend.get(model) ?? 0) + cost);
  }

  /** 选底层 adapter 下标（health-fallback 由 generate 单独处理）。
   * @param request 模型请求（by-task 需要读消息内容）。
   * @returns entries 中被选中条目的下标。
   */
  private select(request: ModelRequest): number {
    switch (this.options.strategy) {
      case 'least-cost':
        return this.selectLeastCost();
      case 'by-task':
        return this.selectByTask(request);
      case 'round-robin':
      case 'health-fallback':
      default:
        return this.nextRoundRobin();
    }
  }

  /** 选累计成本最低者；无 pricing 则回退轮询。
   * @returns 累计成本最低 entry 的下标（并列取先出现者）。
   */
  private selectLeastCost(): number {
    if (!this.options.entries.some((entry) => entry.pricing !== undefined)) {
      return this.nextRoundRobin();
    }
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < this.options.entries.length; i += 1) {
      const cost = this.spend.get(at(this.options.entries, i).model) ?? 0;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    return best;
  }

  /** by-task：含「写/代码」关键词选 entries[0]，含「推理/分析」选 entries[1]，否则轮询。
   * @param request 模型请求（按 taskField 限定取消息文本做匹配）。
   * @returns 匹配到的 entry 下标；两类关键词都不命中时回退轮询。
   */
  private selectByTask(request: ModelRequest): number {
    const messages = this.taskMessages(request);
    const text = messages.map((message) => message.content).join('\n');
    if (BY_TASK_CODE_PATTERN.test(text)) {
      return 0;
    }
    if (BY_TASK_REASON_PATTERN.test(text)) {
      return 1;
    }
    return this.nextRoundRobin();
  }

  /** 取供 by-task 匹配的消息（taskField 限定 role，否则全部）。
   * @param request 模型请求。
   * @returns 参与关键词匹配的消息子集。
   */
  private taskMessages(request: ModelRequest): readonly ModelMessage[] {
    if (this.options.taskField === undefined) {
      return request.messages;
    }
    return request.messages.filter((message) => message.role === this.options.taskField);
  }

  /** 轮询取下一个下标并推进游标。
   * @returns 本轮应使用的 entry 下标（对 entries 长度取模）。
   */
  private nextRoundRobin(): number {
    const index = this.cursor % this.options.entries.length;
    this.cursor += 1;
    return index;
  }
}
