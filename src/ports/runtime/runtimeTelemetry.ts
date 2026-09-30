/**
 * 长期运行遥测端口（I-P4-3 回填基座）。
 *
 * 设计意图：把"长期运行数据"做成**真实可采集、防篡改、可复跑**的基座，而非一次性报告。
 * 每条观测带 `seq`/`prev`/`hash` 哈希链（语义同 `AuditSink`），使中间条目被删/插/改均可检出。
 *
 * 铁律：
 * - 零运行时依赖（仅 Node 内置 `node:fs` / `node:crypto`）。
 * - 数据来源显式标注（`provenance`）：production=真实负载 / seed-bootstrap=已有诚实证据回填 / synthetic-lab=离线仿真。
 *   收紧算法**只认 production**，绝不拿 bootstrap/lab 数据当"真实负载"去调参——这是诚实边界。
 *
 * 本文件已退化为桶：6 个接口各自独立成文件于 `./runtimeTelemetry/`，调用点零改动。
 */

export type { TelemetryProvenance } from './runtimeTelemetry/telemetryProvenance.js';
export type { TelemetryKind } from './runtimeTelemetry/telemetryKind.js';
export type { RuntimeObservation } from './runtimeTelemetry/runtimeObservation.js';
export type { TelemetryChainReport } from './runtimeTelemetry/telemetryChainReport.js';
export type { RuntimeTelemetryInput } from './runtimeTelemetry/runtimeTelemetryInput.js';
export type { RuntimeTelemetryPort } from './runtimeTelemetry/runtimeTelemetryPort.js';
