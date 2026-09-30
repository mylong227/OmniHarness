import type { RuntimeObservation } from './runtimeObservation.js';

/** 记录输入：`ts` 可选（未提供时由 sink 生成当前时间）。 */
export type RuntimeTelemetryInput = Omit<RuntimeObservation, 'seq' | 'prev' | 'hash' | 'ts'> & {
  /** ISO 时间戳（可选，缺省由 sink 生成）。 */
  readonly ts?: string;
};
