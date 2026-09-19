/**
 * 会话事件 → OTLP span 的构造器（把事件流投影为可导出的 trace）。
 *
 * 为什么要有它：`otlpTraceExporter.ts` 只负责「把 span 发出去」，此前**没有任何地方
 * 从真实活动里产出 span** ⇒ 导出器有实现、无接线（2026-09-19 入口可达性审计实测）。
 * 本类补齐产出侧，且保持纯逻辑（无 IO、无全局状态），便于单测与确定性重放。
 *
 * 产出三类 span：
 * - `tool.<name>`：`tool_call` 与同 `callId` 的 `tool_result` 配对，属性含工具名与成败；
 * - `model.<name>`：`model` 事件（用量）→ 属性含 prompt/completion/total token；
 * - `session`：`drain()` 时汇总一个会话的调用次数与 token 总量。
 *
 * 未闭合的调用（有 call 无 result，例如进程被杀）**不产出 span**：宁可少一条，也不伪造结束时间。
 */
import { randomBytes } from 'node:crypto';
import type { SessionEvent } from '../ports/runtime/event.js';
import type { Span } from './otlpTraceExporter.js';

/** 构造器可选项。 */
export interface TraceSpanBuilderOptions {
  /** traceId 生成器（缺省 `randomBytes(16)` 十六进制；测试可注入确定性实现）。 */
  readonly traceIdFactory?: (() => string) | undefined;
  /** spanId 生成器（缺省 `randomBytes(8)` 十六进制；测试可注入确定性实现）。 */
  readonly spanIdFactory?: (() => string) | undefined;
}

/** 会话累计统计（供汇总 span）。 */
interface SessionStats {
  /** 会话 ID。 */
  readonly sessionId: string;
  /** 最早事件时间（毫秒）。 */
  startMs: number;
  /** 最晚事件时间（毫秒）。 */
  endMs: number;
  /** 工具调用条数。 */
  toolCalls: number;
  /** 模型调用条数。 */
  modelCalls: number;
  /** 累计 token（模型未上报用量时不计，绝不臆造）。 */
  tokens: number;
}

/** 尚未闭合的工具调用。 */
interface OpenCall {
  /** 工具名。 */
  readonly name: string;
  /** 起始时间（毫秒）。 */
  readonly startMs: number;
}

/** 会话事件 → span 构造器（无可变全局状态）。 */
export class TraceSpanBuilder {
  /** span 缓冲（`drain` 取走后清空，避免长期驻留）。 */
  private readonly spans: Span[] = [];
  /** 未闭合的工具调用（按 callId）。 */
  private readonly openCalls = new Map<string, OpenCall>();
  /** 当前会话统计。 */
  private stats: SessionStats | null = null;
  /** traceId（一次构造器生命周期内稳定，代表进程内这条 trace）。 */
  private readonly traceId: string;
  /** spanId 生成器。 */
  private readonly spanIdFactory: () => string;

  /**
   * @param options 可选项（id 生成器注入）。
   */
  public constructor(options: TraceSpanBuilderOptions = {}) {
    this.traceId = options.traceIdFactory?.() ?? randomBytes(16).toString('hex');
    this.spanIdFactory = options.spanIdFactory ?? (() => randomBytes(8).toString('hex'));
  }

  /**
   * 消费一条会话事件（就地更新内部状态，无 IO）。
   *
   * @param event 会话事件。
   * @returns 无返回值。
   */
  public consume(event: SessionEvent): void {
    const ts = TraceSpanBuilder.msOf(event.timestamp);
    this.touch(event.sessionId, ts);
    switch (event.type) {
      case 'tool_call':
        this.consumeToolCall(event, ts);
        return;
      case 'tool_result':
        this.consumeToolResult(event, ts);
        return;
      case 'model':
        this.consumeModel(event, ts);
        return;
      default:
        return;
    }
  }

  /**
   * 取走已构造的 span（含当前会话汇总 span）并清空缓冲。
   *
   * @returns span 列表（无内容时为空数组）。
   */
  public drain(): readonly Span[] {
    const stats = this.stats;
    if (stats !== null && stats.toolCalls + stats.modelCalls > 0) {
      this.spans.push({
        traceId: this.traceId,
        spanId: this.spanIdFactory(),
        name: 'session',
        startTimeUnixNano: TraceSpanBuilder.nano(stats.startMs),
        endTimeUnixNano: TraceSpanBuilder.nano(stats.endMs),
        attributes: [
          TraceSpanBuilder.text('session.id', stats.sessionId),
          TraceSpanBuilder.number('session.tool_calls', stats.toolCalls),
          TraceSpanBuilder.number('session.model_calls', stats.modelCalls),
          TraceSpanBuilder.number('session.tokens', stats.tokens),
        ],
      });
      // 窗口语义：汇总 span 报告的是「自上次 drain 起」的增量，故计数清零、起点前移；
      // 否则第二次 drain 会凭陈旧计数再吐一条汇总（重复上报）。
      stats.toolCalls = 0;
      stats.modelCalls = 0;
      stats.tokens = 0;
      stats.startMs = stats.endMs;
    }
    const out = [...this.spans];
    this.spans.length = 0;
    return out;
  }

  /**
   * 是否还有未导出的内容（供装饰器判断是否值得 flush）。
   *
   * @returns 有内容时为 true。
   */
  public hasPending(): boolean {
    return this.spans.length > 0 || this.openCalls.size > 0;
  }

  /**
   * 处理 `tool_call`：登记未闭合调用。
   *
   * @param event 事件。
   * @param ts 事件时间（毫秒）。
   * @returns 无返回值。
   */
  private consumeToolCall(event: SessionEvent, ts: number): void {
    const payload = TraceSpanBuilder.recordOf(event.payload);
    const callId = TraceSpanBuilder.stringOf(payload['callId']);
    const name = TraceSpanBuilder.stringOf(payload['name']);
    if (callId === null || name === null) {
      return;
    }
    this.openCalls.set(callId, { name, startMs: ts });
  }

  /**
   * 处理 `tool_result`：与未闭合调用配对，产出 `tool.<name>` span。
   *
   * @param event 事件。
   * @param ts 事件时间（毫秒）。
   * @returns 无返回值。
   */
  private consumeToolResult(event: SessionEvent, ts: number): void {
    const payload = TraceSpanBuilder.recordOf(event.payload);
    const callId = TraceSpanBuilder.stringOf(payload['callId']);
    if (callId === null) {
      return;
    }
    const open = this.openCalls.get(callId);
    if (open === undefined) {
      // 无对应 call（例如事件流被截断）：不伪造 span。
      return;
    }
    this.openCalls.delete(callId);
    if (this.stats !== null) {
      this.stats.toolCalls += 1;
    }
    this.spans.push({
      traceId: this.traceId,
      spanId: this.spanIdFactory(),
      name: `tool.${open.name}`,
      startTimeUnixNano: TraceSpanBuilder.nano(open.startMs),
      endTimeUnixNano: TraceSpanBuilder.nano(ts),
      attributes: [
        TraceSpanBuilder.text('tool.name', open.name),
        TraceSpanBuilder.text('tool.ok', payload['ok'] === true ? 'true' : 'false'),
        TraceSpanBuilder.text('session.id', event.sessionId),
      ],
    });
  }

  /**
   * 处理 `model`：产出 `model.<name>` span 并累计 token。
   *
   * @param event 事件。
   * @param ts 事件时间（毫秒）。
   * @returns 无返回值。
   */
  private consumeModel(event: SessionEvent, ts: number): void {
    const payload = TraceSpanBuilder.recordOf(event.payload);
    const usage = TraceSpanBuilder.recordOf(payload['usage']);
    const model = TraceSpanBuilder.stringOf(payload['model']) ?? 'unknown';
    const prompt = TraceSpanBuilder.numberOf(usage['promptTokens']);
    const completion = TraceSpanBuilder.numberOf(usage['completionTokens']);
    const total = TraceSpanBuilder.numberOf(usage['totalTokens']);
    if (this.stats !== null) {
      this.stats.modelCalls += 1;
      this.stats.tokens += total;
    }
    this.spans.push({
      traceId: this.traceId,
      spanId: this.spanIdFactory(),
      name: `model.${model}`,
      startTimeUnixNano: TraceSpanBuilder.nano(ts),
      endTimeUnixNano: TraceSpanBuilder.nano(ts),
      attributes: [
        TraceSpanBuilder.text('model.name', model),
        TraceSpanBuilder.number('tokens.prompt', prompt),
        TraceSpanBuilder.number('tokens.completion', completion),
        TraceSpanBuilder.number('tokens.total', total),
        TraceSpanBuilder.text('session.id', event.sessionId),
      ],
    });
  }

  /**
   * 更新当前会话统计（会话切换时重置：`session_meta` 是新会话首条事件）。
   *
   * @param sessionId 事件所属会话。
   * @param ts 事件时间（毫秒）。
   * @returns 无返回值。
   */
  private touch(sessionId: string, ts: number): void {
    if (this.stats === null) {
      this.stats = {
        sessionId,
        startMs: ts,
        endMs: ts,
        toolCalls: 0,
        modelCalls: 0,
        tokens: 0,
      };
      return;
    }
    this.stats.endMs = Math.max(this.stats.endMs, ts);
  }

  /**
   * 时间戳字符串 → 毫秒（无法解析时回落到当前时间，绝不让 NaN 进 span）。
   *
   * @param timestamp ISO 时间戳。
   * @returns 毫秒时间。
   */
  private static msOf(timestamp: string): number {
    const ms = Date.parse(timestamp);
    return Number.isFinite(ms) ? ms : Date.now();
  }

  /**
   * 毫秒 → OTLP 的纳秒字符串。
   *
   * @param ms 毫秒时间。
   * @returns 纳秒字符串。
   */
  private static nano(ms: number): string {
    return String(Math.round(ms * 1e6));
  }

  /**
   * 构造字符串属性。
   *
   * @param key 属性键。
   * @param value 属性值。
   * @returns OTLP 属性。
   */
  private static text(key: string, value: string): { key: string; value: { stringValue: string } } {
    return { key, value: { stringValue: value } };
  }

  /**
   * 构造数值属性（OTLP 子集用字符串承载，去尾零保证确定性）。
   *
   * @param key 属性键。
   * @param value 数值。
   * @returns OTLP 属性。
   */
  private static number(
    key: string,
    value: number,
  ): { key: string; value: { stringValue: string } } {
    return TraceSpanBuilder.text(key, String(value));
  }

  /**
   * 把未知载荷收敛为对象（非对象返回空对象）。
   *
   * @param value 原始载荷。
   * @returns 记录对象。
   */
  private static recordOf(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }

  /**
   * 取字符串字段。
   *
   * @param value 原始值。
   * @returns 字符串；非字符串或空串为 null。
   */
  private static stringOf(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /**
   * 取数值字段。
   *
   * @param value 原始值。
   * @returns 有限数值；否则 0。
   */
  private static numberOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
}
