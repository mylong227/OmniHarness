/**
 * 轻量 OTLP/JSON trace 导出器（无第三方依赖，守依赖准入铁律）。
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
 * 导出器**自观测快照**（G24，2026-10-03 第十轮）。
 *
 * ## 为什么需要它
 *
 * `flush()` 的契约是"失败静默、绝不反噬业务"——这是对的，但它让**丢弃变成不可见**：
 * 一个打错端点的部署会安静地跑几天，没人知道 span 全丢了。本快照把丢弃变成**数字**：
 * 只读字段、无样本给 0、不发警告、不改任何业务分支（照抄本仓 `CacheHitRateCollector` 的范式，
 * 包括"把『没跑过』与『跑过且全丢』区分开"这一点——靠 `batchesSent + batchesDropped == 0` 表达）。
 */
export interface OtlpExporterStats {
  /** 成功送达的批次数（HTTP 视为成功，见 `flush` 的判定）。 */
  readonly batchesSent: number;
  /** 被丢弃的批次数（网络异常或 HTTP 明确失败）。 */
  readonly batchesDropped: number;
  /** 成功送达的 span 数。 */
  readonly spansSent: number;
  /** 被丢弃的 span 数（**这就是"静默丢弃"的计量**）。 */
  readonly spansDropped: number;
  /** 最近一次丢弃原因（`network` / `http_<状态码>`）；从未丢弃时缺省。 */
  readonly lastDropReason?: string;
}

/**
 * OTLP/JSON trace 导出器：缓冲 span 并批量 POST。
 * 默认 fetch 为全局 fetch；无端点时见 {@link NoopTraceExporter}。
 */
export class OtlpTraceExporter implements TraceExporterPort {
  /** 端口标识：固定为 'otlp'。 */
  public readonly name = 'otlp';
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBatch: number;
  private buffer: Span[] = [];
  /** 自观测计数：成功送达的批次数（只累加，不参与任何业务分支）。 */
  private batchesSent = 0;
  /** 自观测计数：被丢弃的批次数（网络异常或 HTTP 明确失败）。 */
  private batchesDropped = 0;
  /** 自观测计数：成功送达的 span 数。 */
  private spansSent = 0;
  /** 自观测计数：被丢弃的 span 数（这就是"静默丢弃"的计量）。 */
  private spansDropped = 0;
  /** 自观测：最近一次丢弃原因（`network` / `http_<状态码>`）；从未丢弃时为 undefined。 */
  private lastDropReason: string | undefined;

  public constructor(options: OtlpExporterOptions) {
    this.endpoint = options.endpoint;
    this.serviceName = options.serviceName ?? 'omniharness';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBatch = options.maxBatch ?? 64;
  }

  /**
   * 自观测快照：把"静默丢弃"变成可断言的数字。
   *
   * 判读口径：`batchesSent + batchesDropped === 0` 表示**从未尝试发送**（不是"一切正常"）；
   * `spansDropped > 0` 表示确有 span 丢失。
   * @returns 只读快照（含最近一次丢弃原因）。
   */
  public stats(): OtlpExporterStats {
    return {
      batchesSent: this.batchesSent,
      batchesDropped: this.batchesDropped,
      spansSent: this.spansSent,
      spansDropped: this.spansDropped,
      ...(this.lastDropReason !== undefined ? { lastDropReason: this.lastDropReason } : {}),
    };
  }

  /**
   * 导出一批 span：先入缓冲，攒到 maxBatch（缺省 64）即触发一次 {@link flush}。
   *
   * @param spans 待导出的 span 列表。
   * @returns 缓冲/刷新完成的 Promise（网络失败静默，不抛错）。
   */
  public async export(spans: readonly Span[]): Promise<void> {
    this.buffer.push(...spans);
    if (this.buffer.length >= this.maxBatch) {
      await this.flush();
    }
  }

  /**
   * 刷新缓冲：把缓冲中的 span 组装为 OTLP resourceSpans JSON，POST 到 Collector（5 秒超时）。
   * 缓冲为空直接返回；发送失败**静默丢弃该批**（可观测性不得反噬业务），但**计入自观测计数器**
   * （G24：静默 ≠ 不可见）。
   *
   * HTTP 判定口径（2026-10-03 第十轮补）：响应**明确** `ok === false` 也算丢弃（原因 `http_<状态码>`）。
   * 此前只判"有没有抛错"⇒ 打错端点返回 404/500 会被当成发送成功，丢弃彻底不可见。
   * 注意这里是**显式**判否（`=== false`），不是"没有 `ok` 就算失败"：注入的极简桩（返回 `{}`）
   * 与真实 `Response` 之外的对象仍按成功计，保持既有测试与用法的兼容。
   *
   * @returns 发送结束后（无论成败）resolve 的 Promise。
   */
  public async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: this.serviceName } }],
          },
          scopeSpans: [{ scope: { name: this.serviceName }, spans: batch }],
        },
      ],
    };
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if ((response as { ok?: unknown }).ok === false) {
        const status = (response as { status?: unknown }).status;
        this.recordDrop(
          batch.length,
          `http_${typeof status === 'number' ? String(status) : 'unknown'}`,
        );
        return;
      }
      this.batchesSent += 1;
      this.spansSent += batch.length;
    } catch {
      // 可观测性失败不可反噬业务：丢弃该批——但必须留下可断言的数字。
      this.recordDrop(batch.length, 'network');
    }
  }

  /**
   * 记一次丢弃（只累加计数，不做任何其它动作）。
   * @param spans 丢弃的 span 数。
   * @param reason 丢弃原因（`network` / `http_<状态码>`）。
   * @returns 无返回值。
   */
  private recordDrop(spans: number, reason: string): void {
    this.batchesDropped += 1;
    this.spansDropped += spans;
    this.lastDropReason = reason;
  }
}

/** 无操作导出器（未配置端点时默认）。 */
export class NoopTraceExporter implements TraceExporterPort {
  /** 端口标识：固定为 'noop'。 */
  public readonly name = 'noop';
  /** no-op：span 仅本地丢弃，立即 resolve。
   * @returns 无返回值。
   */
  public async export(_spans: readonly Span[]): Promise<void> {}
  /** no-op：无缓冲，立即 resolve。
   * @returns 无返回值。
   */
  public async flush(): Promise<void> {}
}
