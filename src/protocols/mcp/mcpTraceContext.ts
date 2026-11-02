/**
 * MCP 2026-07-28 的 OpenTelemetry trace 上下文传播（`_meta` 的 `traceparent`/`tracestate`/`baggage`）。
 *
 * 规范把这三个键作为 `_meta` 前缀规则的**例外**：值必须符合 W3C Trace Context / Baggage 格式。
 * 本类只做**载体**（解析 / 生成子 span / 注入 / AsyncLocalStorage 传递），不引入 OTel SDK——
 * 本仓已有的 trace 身份来自 `Logger.currentTrace()`（UUID 形态）与 OTLP span 构造器，
 * 二者用 trace id 关联；非 32-hex 的既有 id 会被散列成 32-hex，保持同一链路可追溯。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { McpProtocol } from './mcpProtocol.ts';

/** W3C trace 载体（至少含 traceparent）。 */
export interface McpTraceCarrier {
  /** `00-<32hex trace-id>-<16hex span-id>-<2hex flags>`。 */
  readonly traceparent: string;
  /** W3C tracestate（可缺省）。 */
  readonly tracestate?: string | undefined;
  /** W3C baggage（可缺省）。 */
  readonly baggage?: string | undefined;
}

/** 解析出的 traceparent 片段。 */
interface TraceParentParts {
  readonly version: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly flags: string;
}

/**
 * MCP trace 上下文工具（AsyncLocalStorage 传播 + W3C 编解码）。
 */
export class McpTraceContext {
  /** 当前异步上下文的载体。 */
  private static readonly storage = new AsyncLocalStorage<McpTraceCarrier>();

  /** traceparent 严格校验（W3C；允许未来版本带额外字段）。 */
  private static readonly TRACEPARENT =
    /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.+)?$/u;

  /**
   * 在给定载体下执行（供服务端处理请求/日志关联）。
   * @param carrier trace 载体。
   * @param fn 待执行函数。
   * @returns 函数返回值。
   */
  public static run<T>(carrier: McpTraceCarrier, fn: () => T): T {
    return McpTraceContext.storage.run(carrier, fn);
  }

  /**
   * 当前异步上下文的载体。
   * @returns 载体；未设置时为 undefined。
   */
  public static current(): McpTraceCarrier | undefined {
    return McpTraceContext.storage.getStore();
  }

  /**
   * 从请求 `_meta` 解析 trace 载体（缺字段返回 undefined；非法 traceparent 返回 undefined，
   * 由调用方决定是否记录告警——不因一个坏头拒绝整个请求）。
   * @param meta 请求 `_meta`。
   * @returns 载体或 undefined。
   */
  public static parse(meta: Record<string, unknown> | undefined): McpTraceCarrier | undefined {
    if (meta === undefined) return undefined;
    const traceparent = meta[McpProtocol.META_TRACEPARENT];
    if (typeof traceparent !== 'string') return undefined;
    const parts = McpTraceContext.partsOf(traceparent);
    if (parts === undefined) return undefined;
    const tracestate = meta[McpProtocol.META_TRACESTATE];
    const baggage = meta[McpProtocol.META_BAGGAGE];
    return {
      traceparent,
      ...(typeof tracestate === 'string' && tracestate !== '' ? { tracestate } : {}),
      ...(typeof baggage === 'string' && baggage !== '' ? { baggage } : {}),
    };
  }

  /**
   * 由既有 trace id 构造载体（非 32-hex 的 id 先散列）。
   * @param traceId 既有 trace 身份（UUID / 任意字符串）。
   * @returns 新载体（随机新 span id，flags=01）。
   */
  public static fromTraceId(traceId: string): McpTraceCarrier {
    const hex = /^[0-9a-f]{32}$/u.test(traceId)
      ? traceId
      : createHash('sha256').update(traceId, 'utf8').digest('hex').slice(0, 32);
    return {
      traceparent: `00-${hex}-${McpTraceContext.newSpanId()}-01`,
    };
  }

  /**
   * 生成一个没有父上下文的新根载体。
   * @returns 新载体。
   */
  public static root(): McpTraceCarrier {
    return {
      traceparent: `00-${randomBytes(16).toString('hex')}-${McpTraceContext.newSpanId()}-01`,
    };
  }

  /**
   * 由父载体派生**子 span**（同 trace id，新 span id，保留 flags/tracestate/baggage）。
   * @param parent 父载体。
   * @returns 子载体；父载体非法时回落为新根。
   */
  public static child(parent: McpTraceCarrier): McpTraceCarrier {
    const parts = McpTraceContext.partsOf(parent.traceparent);
    if (parts === undefined) return McpTraceContext.root();
    return {
      traceparent: `00-${parts.traceId}-${McpTraceContext.newSpanId()}-${parts.flags}`,
      ...(parent.tracestate !== undefined ? { tracestate: parent.tracestate } : {}),
      ...(parent.baggage !== undefined ? { baggage: parent.baggage } : {}),
    };
  }

  /**
   * 把载体写进 `_meta`（返回新对象，不修改入参）。
   * @param meta 原 `_meta`（可缺省）。
   * @param carrier 载体。
   * @returns 注入后的 `_meta`。
   */
  public static inject(
    meta: Record<string, unknown> | undefined,
    carrier: McpTraceCarrier,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(meta ?? {}) };
    out[McpProtocol.META_TRACEPARENT] = carrier.traceparent;
    if (carrier.tracestate !== undefined) out[McpProtocol.META_TRACESTATE] = carrier.tracestate;
    if (carrier.baggage !== undefined) out[McpProtocol.META_BAGGAGE] = carrier.baggage;
    return out;
  }

  /**
   * 取载体的 trace id（用于日志关联）。
   * @param carrier 载体。
   * @returns 32-hex trace id；非法时 undefined。
   */
  public static traceIdOf(carrier: McpTraceCarrier): string | undefined {
    return McpTraceContext.partsOf(carrier.traceparent)?.traceId;
  }

  /**
   * 生成 16-hex span id（非全零）。
   * @returns span id。
   */
  private static newSpanId(): string {
    for (;;) {
      const id = randomBytes(8).toString('hex');
      if (!/^0+$/u.test(id)) return id;
    }
  }

  /**
   * 拆解并校验 traceparent。
   * @param traceparent traceparent 值。
   * @returns 片段；非法/全零 id 时 undefined。
   */
  private static partsOf(traceparent: string): TraceParentParts | undefined {
    const match = McpTraceContext.TRACEPARENT.exec(traceparent.trim());
    if (match === null) return undefined;
    const version = match[1];
    const traceId = match[2];
    const spanId = match[3];
    const flags = match[4];
    if (
      version === undefined ||
      traceId === undefined ||
      spanId === undefined ||
      flags === undefined
    ) {
      return undefined;
    }
    if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId)) return undefined;
    return { version, traceId, spanId, flags };
  }
}
