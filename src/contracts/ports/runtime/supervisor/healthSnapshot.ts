import type { SafeMode } from './safeMode.ts';
import type { HealthEntry } from './healthEntry.ts';

/** 健康快照：当前模式 + 全部工具健康向量。 */
export interface HealthSnapshot {
  readonly mode: SafeMode;
  readonly entries: ReadonlyArray<HealthEntry>;
  /** ISO 时间戳。 */
  readonly generatedAt: string;
}
