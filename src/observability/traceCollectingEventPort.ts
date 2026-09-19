/**
 * 事件端口装饰器：把会话事件投影为 OTLP span 并导出（可观测性的**接线点**）。
 *
 * 为什么是这个形状：`EventPort` 是 harness 里唯一的「观测/审计/轨迹」插口，
 * 装饰它即可覆盖 CLI、服务端、子代理全部路径，且**不改变任何既有行为**——
 * 事件原样透传给被装饰端口，导出失败静默（可观测性不得反噬业务）。
 *
 * 触发导出的时机：
 * ① 缓冲攒到导出器的 `maxBatch`（在 `OtlpTraceExporter` 内）；
 * ② 新会话首条事件（`session_meta`）到来时，冲刷上一会话的 span；
 * ③ 调用方显式 `flush()`（`Agent.runTask` 的 finally 会调 `EventPort.flush?.()`）。
 *
 * 未配置端点时不该构造本类：装配层（{@link TraceExporterAssembly}）会保持原端口不变。
 */
import type { SessionEvent } from '../ports/runtime/event.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { TraceExporterPort } from './otlpTraceExporter.js';
import { TraceSpanBuilder } from './traceSpanBuilder.js';

/** 装饰器选项。 */
export interface TraceCollectingOptions {
  /** 被装饰的事件端口（事件原样透传给它）。 */
  readonly inner: EventPort;
  /** trace 导出器（OTLP 或 no-op）。 */
  readonly exporter: TraceExporterPort;
  /** span 构造器（缺省新建；测试可注入确定性 id 生成器）。 */
  readonly builder?: TraceSpanBuilder | undefined;
}

/** 事件端口装饰器：透传事件 + 产出并导出 span。 */
export class TraceCollectingEventPort implements EventPort {
  /** 端口标识。 */
  public readonly name = 'trace-collecting';

  /** 被装饰端口。 */
  private readonly inner: EventPort;
  /** 导出器。 */
  private readonly exporter: TraceExporterPort;
  /** span 构造器。 */
  private readonly builder: TraceSpanBuilder;
  /** 当前会话 ID（用于识别会话切换）。 */
  private currentSession: string | null = null;

  /**
   * @param options 选项（被装饰端口 / 导出器 / 构造器）。
   */
  public constructor(options: TraceCollectingOptions) {
    this.inner = options.inner;
    this.exporter = options.exporter;
    this.builder = options.builder ?? new TraceSpanBuilder();
  }

  /**
   * 透传事件并消费为 span；会话切换时先冲刷上一会话。
   *
   * @param event 会话事件。
   * @returns 无返回值（导出为后台进行，失败静默）。
   */
  public emit(event: SessionEvent): void {
    this.inner.emit(event);
    if (
      event.type === 'session_meta' &&
      this.currentSession !== null &&
      this.builder.hasPending()
    ) {
      void this.flush();
    }
    this.currentSession = event.sessionId;
    this.builder.consume(event);
  }

  /**
   * 冲刷：把已构造的 span 导出并等待导出器清空缓冲。
   *
   * @returns 导出完成（无论成败）的 Promise。
   */
  public async flush(): Promise<void> {
    const spans = this.builder.drain();
    if (spans.length === 0) {
      return;
    }
    await this.exporter.export(spans);
    await this.exporter.flush();
  }

  /**
   * 被装饰端口名（可观测性：`trace-collecting(console)`）。
   *
   * @returns 组合后的端口标识。
   */
  public innerName(): string {
    return this.inner.name;
  }
}
