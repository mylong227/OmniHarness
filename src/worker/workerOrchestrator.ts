import { ParallelMap } from '../util/parallelMap.js';
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
  /**
   * @param registry worker 注册表（按名取 worker，未注册名经其抛错）
   */
  public constructor(private readonly registry: WorkerRegistry) {}

  /**
   * 分发单个任务。
   * @param task 委派任务（worker 名 + 任务文本）
   * @param workspaceRoot 子进程工作目录（工作区根）
   * @returns 该 worker 的执行结果（成功含输出与耗时，失败含错误消息）
   */
  public async delegate(task: DelegateTask, workspaceRoot: string): Promise<WorkerResult> {
    return this.registry.get(task.worker).run({ task: task.task, workspaceRoot });
  }

  /**
   * 批量分发（一次任务内调度多个 worker）。
   *
   * 并发：默认 `concurrency = 1`（严格串行，保持原「逐个执行」语义）；N>1 时走
   * {@link ParallelMap} 有界均衡并行——各 worker 是**独立子进程**，彼此无共享可变状态，
   * 故并行安全；结果仍与 `tasks` **严格同序**。
   *
   * @param tasks 委派任务清单
   * @param workspaceRoot 子进程工作目录（全部任务共用）
   * @param concurrency 并发上限（默认 1=串行）
   * @returns 与任务清单顺序一一对应的结果数组
   */
  public async delegateAll(
    tasks: readonly DelegateTask[],
    workspaceRoot: string,
    concurrency = 1,
  ): Promise<readonly WorkerResult[]> {
    return new ParallelMap(concurrency).map(tasks, (task) => this.delegate(task, workspaceRoot));
  }
}
