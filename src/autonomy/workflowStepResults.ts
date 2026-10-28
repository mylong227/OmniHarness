import type { AgentResult } from '../ports/runtime/agent.ts';
import type { WorkflowStep, WorkflowStepResult } from './workflowTypes.ts';
import type { GraphNodeStatus } from '../ports/autonomy/graphNodeStatus.ts';

/** 节点状态变更（与 `WorkflowRunner` 的 `GraphNodeUpdate` 结构相同，避免反向 import）。 */
export interface WorkflowNodeUpdate {
  readonly id: string;
  readonly status: GraphNodeStatus;
  readonly error?: string;
  readonly steps?: number;
  readonly durationMs?: number;
}

/**
 * 工作流步骤结果构造（2026-10-29，A5：从 `WorkflowRunner` 抽出，压体量阈值）。
 *
 * 只负责「结果对象 + 节点状态广播」，不碰调度/取消。
 */
export class WorkflowStepResults {
  /**
   * 成功结果。
   * @param step 步骤。
   * @param outcome 子代理结果。
   * @param startedAt 开始时刻（毫秒）。
   * @param onUpdate 节点状态回调。
   * @returns 成功结果。
   */
  public static done(
    step: WorkflowStep,
    outcome: AgentResult,
    startedAt: number,
    onUpdate?: ((update: WorkflowNodeUpdate) => void) | undefined,
  ): WorkflowStepResult {
    const durationMs = Date.now() - startedAt;
    onUpdate?.({ id: step.id, status: 'done', steps: outcome.steps, durationMs });
    return {
      id: step.id,
      ok: true,
      status: 'done',
      output: outcome.finalText,
      steps: outcome.steps,
      durationMs,
      // 「步数耗尽」不等于「任务完成」：如实透传，供渲染层与下游注入处标注。
      truncated: outcome.truncated === true ? true : undefined,
      aborted: outcome.aborted === true ? true : undefined,
    };
  }

  /**
   * 失败结果。
   * @param step 步骤。
   * @param error 失败原因。
   * @param startedAt 开始时刻（毫秒）。
   * @param onUpdate 节点状态回调。
   * @returns 失败结果。
   */
  public static failed(
    step: WorkflowStep,
    error: string,
    startedAt: number,
    onUpdate?: ((update: WorkflowNodeUpdate) => void) | undefined,
  ): WorkflowStepResult {
    const durationMs = Date.now() - startedAt;
    onUpdate?.({ id: step.id, status: 'failed', error, durationMs });
    return { id: step.id, ok: false, status: 'failed', error, steps: 0, durationMs };
  }
}
