/**
 * 轻量 OTLP/JSON metrics 导出器（OBS-01，2026-10-20）。
 *
 * 与 trace 导出器同一哲学：不引 `@opentelemetry/*`，直接构造规范子集，POST 到 Collector；
 * 无端点时由装配层决定不装。计数是**累计量**（cumulative sum），flush 时整包发送。
 */

/** 指标属性值（只支持字符串/整数，够本仓用）。 */
export type MetricAttributeValue = string | number;

/** 指标点（内部累计表用）。 */
interface CounterEntry {
  readonly name: string;
  readonly attributes: Readonly<Record<string, MetricAttributeValue>>;
  value: number;
}

/** 导出器选项。 */
export interface OtlpMetricsExporterOptions {
  readonly endpoint: string;
  readonly serviceName?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** 导出器自观测。 */
export interface OtlpMetricsStats {
  readonly flushes: number;
  readonly dropped: number;
  readonly points: number;
}

/**
 * OTLP metrics 导出器：累计计数器 + 批量 flush。
 */
export class OtlpMetricsExporter {
  /** 导出器名。 */
  public readonly name = 'otlp-metrics';
  /** Collector metrics 端点。 */
  private readonly endpoint: string;
  /** service.name 资源属性。 */
  private readonly serviceName: string;
  /** fetch 实现（测试可注入）。 */
  private readonly fetchImpl: typeof fetch;
  /** 累计计数表（键 = 指标名 + 属性）。 */
  private readonly counters = new Map<string, CounterEntry>();
  /** 成功 flush 次数（自观测）。 */
  private flushes = 0;
  /** 丢弃的指标点数（自观测）。 */
  private dropped = 0;

  /**
   * @param options 端点与服务名。
   */
  public constructor(options: OtlpMetricsExporterOptions) {
    this.endpoint = options.endpoint;
    this.serviceName = options.serviceName ?? 'omniharness';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 累加一个计数。
   * @param name 指标名（如 `omniharness.tool.calls`）。
   * @param value 增量（默认 1）。
   * @param attributes 属性（键值稳定；同一组合累加）。
   * @returns 无返回值。
   */
  public record(
    name: string,
    value = 1,
    attributes: Record<string, MetricAttributeValue> = {},
  ): void {
    const key = `${name}|${JSON.stringify(attributes)}`;
    const existing = this.counters.get(key);
    if (existing === undefined) {
      this.counters.set(key, { name, attributes, value });
    } else {
      existing.value += value;
    }
  }

  /**
   * 把当前累计量作为一批 OTLP metrics POST 出去。
   * @returns 完成（失败静默，只计数）。
   */
  public async flush(): Promise<void> {
    if (this.counters.size === 0) return;
    const metrics = [...this.counters.values()].map((entry) => ({
      name: entry.name,
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          {
            asInt: String(entry.value),
            timeUnixNano: String(Date.now() * 1_000_000),
            attributes: Object.entries(entry.attributes).map(([key, value]) => ({
              key,
              value:
                typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
            })),
          },
        ],
      },
    }));
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceMetrics: [
            {
              resource: {
                attributes: [{ key: 'service.name', value: { stringValue: this.serviceName } }],
              },
              scopeMetrics: [{ scope: { name: 'omniharness' }, metrics }],
            },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok === false) {
        this.dropped += metrics.length;
      } else {
        this.flushes += 1;
      }
    } catch {
      this.dropped += metrics.length;
    }
  }

  /**
   * 自观测快照。
   * @returns flush/丢弃/指标点数。
   */
  public stats(): OtlpMetricsStats {
    return {
      flushes: this.flushes,
      dropped: this.dropped,
      points: this.counters.size,
    };
  }
}
