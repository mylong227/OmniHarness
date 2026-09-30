import type { SafeMode } from './safeMode.js';
import type { HealthEntry } from './healthEntry.js';

/** 健康快照：当前模式 + 全部工具健康向量。 */
export interface HealthSnapshot {
  readonly mode: SafeMode;
  readonly entries: ReadonlyArray<HealthEntry>;
  /** ISO 时间戳。 */
  readonly generatedAt: string;
}
