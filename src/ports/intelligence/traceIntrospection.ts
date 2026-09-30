/**
 * 只读自省 trace 端口（T4.5 · H5 · Harness Engineering）。
 *
 * 解决的问题：agent 想自查「我刚做了什么」时，唯一渠道是写通道（事件日志/记录器），
 * 既是写口又是读口——agent 一次误操作就能污染自己的历史。本端口把「读 trace」收成
 * **纯只读面**：实现方保证返回深拷贝/冻结快照，调用方（agent 工具、自评器）无法借道修改。
 *
 * 可复现消费：条目带稳定 seq 与 ISO 时间，同过滤条件恒同结果（事件流不重排）。
 *
 * 本文件已退化为桶：5 个接口各自独立成文件于 `./traceIntrospection/`，调用点零改动。
 */

export type { TraceEntry } from './traceIntrospection/traceEntry.js';
export type { TraceFilter } from './traceIntrospection/traceFilter.js';
export type { TraceReadRequest } from './traceIntrospection/traceReadRequest.js';
export type { TraceReadResult } from './traceIntrospection/traceReadResult.js';
export type { TraceIntrospectionPort } from './traceIntrospection/traceIntrospectionPort.js';
