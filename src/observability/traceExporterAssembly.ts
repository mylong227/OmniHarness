/**
 * trace 导出器的**装配层**：按环境把事件端口包上 OTLP 收集器。
 *
 * 为什么放在这里而不是配置 schema 里：可观测性是可选增强，端点缺失时必须**零行为变更**。
 * 本仓既有先例（`OMNI_REPO_MAP` / `OMNI_RERANK` / `OMNI_SEMANTIC_RECALL`）也是「env 驱动的
 * 可选能力不增 config schema」，以免破坏配置的 fail-closed 校验与接线完整性门禁。
 *
 * 环境变量：
 * - `OTEL_EXPORTER_OTLP_ENDPOINT`（业界标准名）：设了才启用；例 `http://127.0.0.1:4318/v1/traces`；
 * - `OMNI_OTLP_SERVICE_NAME`：可选，`service.name` 资源属性（缺省 `omniharness`）。
 */
import type { EventPort } from '../ports/runtime/eventPort.js';
import {
  NoopTraceExporter,
  OtlpTraceExporter,
  type TraceExporterPort,
} from './otlpTraceExporter.js';
import { TraceCollectingEventPort } from './traceCollectingEventPort.js';
import { TraceSpanBuilder } from './traceSpanBuilder.js';

/** trace 装配器（纯静态）。 */
export class TraceExporterAssembly {
  /** 端点环境变量名（OTLP 规范）。 */
  public static readonly ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

  /** 服务名环境变量名。 */
  public static readonly SERVICE_ENV = 'OMNI_OTLP_SERVICE_NAME';

  private constructor() {}

  /**
   * 按环境包装事件端口。
   *
   * @param port 原始事件端口。
   * @param env 环境变量表（缺省 `process.env`；测试可注入）。
   * @returns 设了端点时为装饰后的端口，否则**原样返回**（零行为变更）。
   */
  public static wrap(
    port: EventPort,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): EventPort {
    const endpoint = (env[TraceExporterAssembly.ENDPOINT_ENV] ?? '').trim();
    if (endpoint === '') {
      return port;
    }
    return new TraceCollectingEventPort({
      inner: port,
      exporter: TraceExporterAssembly.exporterFor(endpoint, env),
      builder: new TraceSpanBuilder(),
    });
  }

  /**
   * 按端点构造导出器。
   *
   * @param endpoint Collector 端点。
   * @param env 环境变量表（取服务名）。
   * @returns 导出器（端点为空时 no-op，防御性分支）。
   */
  public static exporterFor(
    endpoint: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): TraceExporterPort {
    const trimmed = endpoint.trim();
    if (trimmed === '') {
      return new NoopTraceExporter();
    }
    const service = (env[TraceExporterAssembly.SERVICE_ENV] ?? '').trim();
    return new OtlpTraceExporter({
      endpoint: trimmed,
      ...(service !== '' ? { serviceName: service } : {}),
    });
  }

  /**
   * 环境里是否启用了 OTLP 导出（供 CLI/诊断打印能力自述）。
   *
   * @param env 环境变量表。
   * @returns 启用时为 true。
   */
  public static enabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
    return (env[TraceExporterAssembly.ENDPOINT_ENV] ?? '').trim() !== '';
  }
}
