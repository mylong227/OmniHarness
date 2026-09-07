/**
 * 轻量 OTLP/JSON trace 导出器（零依赖，守依赖准入铁律）。
 *
 * 不引入 `@opentelemetry/*` SDK，而是直接构造 OTLP 的 `traces` JSON 负载（规范子集：
 * resourceSpans → scopeSpans → spans），经 HTTP POST 到 Collector。无端点时退化为 no-op
 * （span 仅本地丢弃，不报错），使可观测性成为可选增强而非硬依赖。
 */

/** 单个 span（OTLP 子集）。 */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes?: readonly { key: string; value: { stringValue: string } }[];
}

/** trace 导出端口。 */
export interface TraceExporterPort {
  readonly name: string;
  /** 导出一批 span（失败静默，不阻断主流程——可观测性不得反噬业务）。 */
  export(spans: readonly Span[]): Promise<void>;
  /** 刷新缓冲（进程退出前调用）。 */
  flush(): Promise<void>;
}

/** OTLP/JSON 导出器选项。 */
export interface OtlpExporterOptions {
  /** Collector 端点（OTLP/HTTP traces 路径）。 */
  readonly endpoint: string;
  /** 服务名（写入 resource.attributes）。 */
  readonly serviceName?: string;
  /** 注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 最大缓冲 span 数，超出即触发 flush。 */
  readonly maxBatch?: number;
}

/**
 * OTLP/JSON trace 导出器：缓冲 span 并批量 POST。
 * 默认 fetch 为全局 fetch；无端点时见 {@link NoopTraceExporter}。
 */
export class OtlpTraceExporter implements TraceExporterPort {
  readonly name = 'otlp';
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBatch: number;
  private buffer: Span[] = [];

  constructor(options: OtlpExporterOptions) {
    this.endpoint = options.endpoint;
    this.serviceName = options.serviceName ?? 'omniharness';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBatch = options.maxBatch ?? 64;
  }

  async export(spans: readonly Span[]): Promise<void> {
    this.buffer.push(...spans);
    if (this.buffer.length >= this.maxBatch) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: this.serviceName } }] },
          scopeSpans: [{ scope: { name: this.serviceName }, spans: batch }],
        },
      ],
    };
    try {
      await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // 可观测性失败不可反噬业务：丢弃该批。
    }
  }
}

/** 无操作导出器（未配置端点时默认）。 */
export class NoopTraceExporter implements TraceExporterPort {
  readonly name = 'noop';
  async export(_spans: readonly Span[]): Promise<void> {}
  async flush(): Promise<void> {}
}
