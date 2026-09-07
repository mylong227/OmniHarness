import type { WorkerRegistry } from './workerRegistry.js';
import type { WorkerResult } from './worker.js';

/**
 * @beta
 * 编排任务。
 */
export interface DelegateTask {
  readonly worker: string;
  readonly task: string;
}

/**
 * @beta
 * Worker 编排器：把子任务分发给多个 harness worker，统一汇总。
 */
export class WorkerOrchestrator {
  constructor(private readonly registry: WorkerRegistry) {}

  /** 分发单个任务。 */
  async delegate(task: DelegateTask, workspaceRoot: string): Promise<WorkerResult> {
    return this.registry.get(task.worker).run({ task: task.task, workspaceRoot });
  }

  /** 批量分发（一次任务内调度多个 worker）。 */
  async delegateAll(
    tasks: readonly DelegateTask[],
    workspaceRoot: string,
  ): Promise<readonly WorkerResult[]> {
    const results: WorkerResult[] = [];
    for (const task of tasks) {
      results.push(await this.delegate(task, workspaceRoot));
    }
    return results;
  }
}
