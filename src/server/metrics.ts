import type { SessionEvent } from '../ports/runtime/event.js';

/** 单指标对象（Prometheus 文本用）。 */
export interface MetricLine {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge' | 'summary' | 'histogram';
  readonly value: string;
}

/** 指标快照。 */
export interface MetricsSnapshot {
  readonly eventsByType: Record<string, number>;
  readonly sessions: number;
  readonly turns: TurnStats;
  readonly toolCalls: Record<string, { calls: number; durationMs: number }>;
  readonly tokens: Record<
    string,
    { calls: number; prompt: number; completion: number; total: number }
  >;
  readonly cost: Record<string, { input: number; output: number; currency: string }>;
}

/** 回合耗时统计。 */
export interface TurnStats {
  readonly count: number;
  readonly sumMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/** 指标：事件计数 + 会话数 + 性能/成本可观测（零依赖）。 */
export class Metrics {
  /** 事件类型 -> 累计次数。 */
  private readonly eventsByType = new Map<string, number>();
  /** 见过的会话 id 集合（size 即会话数）。 */
  private readonly sessions = new Set<string>();

  /** 回合计数。 */
  private turnCount = 0;
  /** 回合耗时总和（毫秒）。 */
  private turnSumMs = 0;
  /** 回合耗时最小值（毫秒；无样本时为 Infinity，快照时归 0）。 */
  private turnMinMs = Infinity;
  /** 回合耗时最大值（毫秒；无样本时为 -Infinity，快照时归 0）。 */
  private turnMaxMs = -Infinity;

  /** 工具名 -> 调用次数 + 累计耗时（毫秒）。 */
  private readonly toolCalls = new Map<string, { calls: number; durationMs: number }>();
  /** 模型 -> token 数 + 调用次数。 */
  private readonly tokens = new Map<
    string,
    { calls: number; prompt: number; completion: number; total: number }
  >();
  /** 模型 -> 成本（USD）。 */
  private readonly cost = new Map<string, { input: number; output: number; currency: string }>();

  /**
   * 记录事件；model 事件顺带累计 token 用量与调用次数（按模型分组）。
   * @param event 会话事件（type + sessionId + payload）。
   * @returns 无返回值。
   */
  public recordEvent(event: SessionEvent): void {
    this.eventsByType.set(event.type, (this.eventsByType.get(event.type) ?? 0) + 1);
    this.sessions.add(event.sessionId);
    if (event.type === 'model') {
      const payload = event.payload as
        | {
            usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
            model?: string;
          }
        | undefined;
      const usage = payload?.usage;
      if (usage !== undefined) {
        const prompt = usage.promptTokens ?? 0;
        const completion = usage.completionTokens ?? 0;
        this.recordTokens(payload?.model ?? 'unknown', prompt, completion);
        this.recordModelCall(payload?.model ?? 'unknown');
      }
    }
  }

  /**
   * 记录回合耗时（毫秒）。
   * @param latencyMs 本回合耗时（非有限值忽略）。
   * @returns 无返回值。
   */
  public recordTurn(latencyMs: number): void {
    if (!Number.isFinite(latencyMs)) return;
    this.turnCount += 1;
    this.turnSumMs += latencyMs;
    if (latencyMs < this.turnMinMs) this.turnMinMs = latencyMs;
    if (latencyMs > this.turnMaxMs) this.turnMaxMs = latencyMs;
  }

  /**
   * 记录工具调用。
   * @param tool 工具名。
   * @param durationMs 本次调用耗时（非有限值忽略）。
   * @returns 无返回值。
   */
  public recordToolCall(tool: string, durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const prev = this.toolCalls.get(tool) ?? { calls: 0, durationMs: 0 };
    this.toolCalls.set(tool, { calls: prev.calls + 1, durationMs: prev.durationMs + durationMs });
  }

  /**
   * 记录 token 用量（按模型；total 恒为 prompt+completion，与 recordModelCall 搭配不双计）。
   * @param model 模型名。
   * @param prompt 提示 token 数。
   * @param completion 补全 token 数。
   * @returns 无返回值。
   */
  public recordTokens(model: string, prompt: number, completion: number): void {
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return;
    const prev = this.tokens.get(model) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
    this.tokens.set(model, {
      calls: prev.calls,
      prompt: prev.prompt + prompt,
      completion: prev.completion + completion,
      total: prev.total + prompt + completion,
    });
  }

  /**
   * 记录一次模型调用（按模型累计调用次数）。
   * @param model 模型名。
   * @returns 无返回值。
   */
  public recordModelCall(model: string): void {
    const prev = this.tokens.get(model) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
    this.tokens.set(model, { ...prev, calls: prev.calls + 1 });
  }

  /**
   * 记录成本（按模型，货币记为 USD）。
   * @param model 模型名。
   * @param inputCost 输入成本（非有限值忽略）。
   * @param outputCost 输出成本（非有限值忽略）。
   * @returns 无返回值。
   */
  public recordCost(model: string, inputCost: number, outputCost: number): void {
    if (!Number.isFinite(inputCost) || !Number.isFinite(outputCost)) return;
    const prev = this.cost.get(model) ?? { input: 0, output: 0, currency: 'USD' };
    this.cost.set(model, {
      input: prev.input + inputCost,
      output: prev.output + outputCost,
      currency: 'USD',
    });
  }

  /**
   * 快照（向后兼容，含新增字段）。
   * @returns 指标快照（事件计数、会话数、回合耗时、工具/token/成本分组）。
   */
  public snapshot(): MetricsSnapshot {
    const turns: TurnStats = {
      count: this.turnCount,
      sumMs: this.turnSumMs,
      minMs: this.turnCount > 0 ? this.turnMinMs : 0,
      maxMs: this.turnCount > 0 ? this.turnMaxMs : 0,
    };
    return {
      eventsByType: Object.fromEntries(this.eventsByType),
      sessions: this.sessions.size,
      turns,
      toolCalls: Object.fromEntries(this.toolCalls),
      tokens: Object.fromEntries(this.tokens),
      cost: Object.fromEntries(this.cost),
    };
  }

  /**
   * 渲染为 Prometheus 文本格式。
   * @returns `# HELP` / `# TYPE` + 样本行序列（按名称排序，末尾带换行）。
   */
  public toPrometheus(): string {
    const lines: string[] = [];
    const push = (name: string, help: string, type: string, value: string, labels?: string) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}${labels ?? ''} ${value}`);
    };

    push(
      'omni_turn_duration_seconds',
      'Turn latency in seconds',
      'summary',
      (this.turnCount > 0 ? this.turnSumMs / 1000 : 0).toString(),
    );

    const tools = [...this.toolCalls.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [tool, { calls, durationMs }] of tools) {
      push(
        'omni_tool_calls_total',
        'Tool call count',
        'counter',
        calls.toString(),
        `{tool="${tool}"}`,
      );
      push(
        'omni_tool_duration_seconds',
        'Tool duration in seconds',
        'counter',
        (durationMs / 1000).toString(),
        `{tool="${tool}"}`,
      );
    }

    const tokenModels = [...this.tokens.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [model, { prompt, completion }] of tokenModels) {
      push(
        'omni_tokens_total',
        'Token usage',
        'counter',
        prompt.toString(),
        `{model="${model}",kind="prompt"}`,
      );
      push(
        'omni_tokens_total',
        'Token usage',
        'counter',
        completion.toString(),
        `{model="${model}",kind="completion"}`,
      );
    }

    const costModels = [...this.cost.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [model, { input, output }] of costModels) {
      push(
        'omni_cost_total',
        'Cost in USD',
        'counter',
        (input + output).toString(),
        `{model="${model}"}`,
      );
    }

    const eventTypes = [...this.eventsByType.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [type, count] of eventTypes) {
      push('omni_events_total', 'Events by type', 'counter', count.toString(), `{type="${type}"}`);
    }

    push('omni_sessions', 'Active sessions', 'gauge', this.sessions.size.toString());

    return lines.join('\n') + '\n';
  }
}
