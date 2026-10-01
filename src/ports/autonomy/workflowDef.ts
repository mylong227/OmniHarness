import type { WorkflowStep } from './workflowStep.js';

/**
 * 工作流定义（DAG）。
 */
export interface WorkflowDef {
  readonly name?: string;
  /** 有向无环图的节点。 */
  readonly steps: readonly WorkflowStep[];
  /** 同层最大并发步数（默认 4）。 */
  readonly maxConcurrency?: number;
}
