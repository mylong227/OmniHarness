import type { AnnealStepReport } from './annealStepReport.js';

/** 记忆退火器端口。 */
export interface MemoryAnnealer {
  readonly name: string;
  /** 跑一步退火重加权（离散热方程扩散 + 冷却 + 衰减）。返回本步报告。 */
  anneal(): AnnealStepReport;
  /** 当前温度（退火调度状态，随步数单调下降）。 */
  readonly temperature: number;
  /** 已跑步数。 */
  readonly steps: number;
}
