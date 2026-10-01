import type { RoutineModelAdapter } from './routineModelAdapter.js';
import type { RoutineSchedule } from './routineSchedule.js';

/**
 * @beta
 */
export interface Routine {
  /** 任务名（add/remove/markRun 的匹配键）。 */
  readonly name: string;
  /** 执行提示词。 */
  readonly prompt: string;
  /** 定时任务使用的模型适配器。 */
  readonly modelAdapter: RoutineModelAdapter;
  /** 调度策略（interval / cron）。 */
  readonly schedule: RoutineSchedule;
  /** 上次执行时间戳（ms）；未执行过为 undefined。 */
  readonly lastRun?: number | undefined;
}
