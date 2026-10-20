import type { EventPort } from '../ports/runtime/eventPort.ts';
import type { SessionEvent } from '../ports/runtime/event.ts';
import type { OtlpMetricsExporter } from './otlpMetricsExporter.ts';

/** 选项。 */
export interface MetricsCollectingEventPortOptions {
  readonly inner: EventPort;
  readonly exporter: OtlpMetricsExporter;
  /** 每 N 个事件 flush 一次（默认 20）。 */
  readonly flushEvery?: number | undefined;
}

/**
 * 事件端口 → OTLP metrics 装饰器（OBS-01）。
 *
 * 只做计数，不改变事件流；flush 失败不反噬业务（导出器内部静默）。
 * 计数口径：事件类型、工具调用/错误、prompt/completion token。
 */
export class MetricsCollectingEventPort implements EventPort {
  /** 端口名。 */
  public readonly name = 'metrics';
  /** 距上次 flush 的事件数。 */
  private sinceFlush = 0;

  /**
   * @param options 内层端口与导出器。
   */
  public constructor(private readonly options: MetricsCollectingEventPortOptions) {}

  /**
   * 转发事件并计数。
   * @param event 会话事件。
   * @returns 无返回值。
   */
  public emit(event: SessionEvent): void {
    this.options.inner.emit(event);
    this.options.exporter.record('omniharness.events', 1, { type: event.type });
    if (event.type === 'tool_call') {
      const name = (event.payload as { name?: string }).name ?? 'unknown';
      this.options.exporter.record('omniharness.tool.calls', 1, { tool: name });
    }
    if (event.type === 'tool_result') {
      const payload = event.payload as { callId?: string; ok?: boolean };
      if (payload.ok !== true) {
        this.options.exporter.record('omniharness.tool.errors', 1, {
          callId: payload.callId ?? '?',
        });
      }
    }
    if (event.type === 'model') {
      const usage = (
        event.payload as { usage?: { promptTokens?: number; completionTokens?: number } }
      ).usage;
      if (usage?.promptTokens !== undefined) {
        this.options.exporter.record('omniharness.tokens.prompt', usage.promptTokens);
      }
      if (usage?.completionTokens !== undefined) {
        this.options.exporter.record('omniharness.tokens.completion', usage.completionTokens);
      }
    }
    this.sinceFlush += 1;
    if (this.sinceFlush >= (this.options.flushEvery ?? 20)) {
      this.sinceFlush = 0;
      void this.options.exporter.flush();
    }
  }

  /**
   * 冲刷 metrics 与内层端口。
   * @returns 完成。
   */
  public async flush(): Promise<void> {
    await this.options.exporter.flush();
    await this.options.inner.flush?.();
  }
}
