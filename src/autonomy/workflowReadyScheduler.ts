/**
 * 工作流**就绪队列调度器**（全只读 DAG 去掉层屏障）。
 *
 * 每轮：裁决依赖已终态的步骤 → 按底位级填满并发槽 → 等任意一个完成 → 重算。
 * 写安全由调用方保证：只有 `WorkflowLayerPolicy.mayWrite` 全为 false 时才使用本调度器。
 *
 * @maturity L2 — 真实就绪队列/完成即重算；未做加权耗时与抢占
 * @maturityEvidence tests/unit/workflowReadyScheduling.test.ts
 */
import { WorkflowGuard } from './workflowGuard.ts';
import { WorkflowPriority } from './workflowPriority.ts';
import { WorkflowStepStatuses } from './workflowStepStatuses.ts';
import { CANCELLED_BY_PARENT_MESSAGE } from '../subagent/subagentTypes.ts';
import type { WorkflowStep } from './workflowTypes.ts';
import type { WorkflowStepResult } from './workflowTypes.ts';
import type { WorkflowStepStatus } from '../ports/autonomy/workflowStepStatus.ts';

/** 一次裁决结果。 */
export interface ReadyVerdict {
  /** 可执行步骤 id（原顺序）。 */
  readonly runnable: readonly string[];
  /** 直接判终态的步骤。 */
  readonly settled: readonly {
    readonly id: string;
    readonly status: WorkflowStepStatus;
    readonly error: string;
  }[];
}

/** 调度器钩子（由 WorkflowRunner 提供执行/记账）。 */
export interface ReadySchedulerHooks {
  readonly maxConcurrency: number;
  readonly priority: ReadonlyMap<string, number> | undefined;
  /** 父会话是否已取消。 */
  isCancelled(): boolean;
  /** 执行一个步骤。 */
  execute(id: string): Promise<WorkflowStepResult>;
  /** 记账未执行步骤。 */
  onSettled(records: ReadyVerdict['settled']): void;
  /** 记账已执行步骤。 */
  onExecuted(result: WorkflowStepResult): void;
  /** 裁决当前可判定步骤。 */
  classify(pending: ReadonlySet<string>): ReadyVerdict;
}

/** 就绪队列调度器。 */
export class WorkflowReadyScheduler {
  /**
   * @param hooks 执行/记账钩子。
   */
  public constructor(private readonly hooks: ReadySchedulerHooks) {}

  /**
   * 跑完给定步骤集合。
   * @param ids 全部步骤 id（原顺序）。
   * @returns 无返回值。
   */
  public async run(ids: readonly string[]): Promise<void> {
    const pending = new Set(ids);
    const running = new Map<string, Promise<WorkflowStepResult>>();
    while (pending.size > 0 || running.size > 0) {
      if (this.hooks.isCancelled()) {
        const cancelled = [...pending].map((id) => ({
          id,
          status: 'cancelled' as const,
          error: CANCELLED_BY_PARENT_MESSAGE,
        }));
        this.hooks.onSettled(cancelled);
        pending.clear();
      }
      const verdict = this.hooks.classify(pending);
      this.hooks.onSettled(verdict.settled);
      for (const record of verdict.settled) pending.delete(record.id);
      const capacity = this.hooks.maxConcurrency - running.size;
      const ordered =
        this.hooks.priority === undefined
          ? verdict.runnable
          : WorkflowPriority.order(verdict.runnable, this.hooks.priority);
      for (const id of ordered.slice(0, Math.max(0, capacity))) {
        pending.delete(id);
        running.set(id, this.hooks.execute(id));
      }
      if (running.size === 0) {
        if (pending.size > 0) {
          const blocked = [...pending].map((id) => ({
            id,
            status: 'blocked' as const,
            error: '调度器无进展（依赖或条件未满足）',
          }));
          this.hooks.onSettled(blocked);
          pending.clear();
        }
        break;
      }
      const completed = await Promise.race(
        [...running.entries()].map(async ([id, promise]) => ({ id, result: await promise })),
      );
      running.delete(completed.id);
      this.hooks.onExecuted(completed.result);
    }
  }

  /**
   * 构造「被上游拖死」的可读原因（与条件跳过的措辞区分开，避免事后误读）。
   * @param blockedBy 处于阻塞终态的依赖 id 列表。
   * @returns 原因文本。
   */
  public static blockedReason(blockedBy: readonly string[]): string {
    return `上游依赖失败/未完成（${blockedBy.join('、')}），已跳过`;
  }

  /**
   * 裁决当前可判定步骤：依赖与 `when` 观察目标都已终态才判定。
   * @param pending 未终态步骤。
   * @param byId 步骤索引。
   * @param statuses 终态表。
   * @param blackboard 产出黑板。
   * @param blockedReason 构造阻塞原因。
   * @returns 裁决结果。
   */
  public static classify(
    pending: ReadonlySet<string>,
    byId: ReadonlyMap<string, WorkflowStep>,
    statuses: ReadonlyMap<string, WorkflowStepStatus>,
    blackboard: Readonly<Record<string, string>>,
    blockedReason: (deps: readonly string[]) => string,
  ): ReadyVerdict {
    const runnable: string[] = [];
    const settled: { id: string; status: WorkflowStepStatus; error: string }[] = [];
    for (const id of pending) {
      if (statuses.has(id)) continue;
      const step = byId.get(id);
      if (step === undefined) continue;
      const deps = step.dependsOn ?? [];
      if (!deps.every((dep) => statuses.has(dep))) continue;
      if (step.when !== undefined && !statuses.has(step.when.step)) continue;
      const blockedBy = deps.filter((dep) => {
        const depStatus = statuses.get(dep);
        return depStatus !== undefined && WorkflowStepStatuses.blocksDownstream(depStatus);
      });
      if (step.when !== undefined) {
        const verdict = WorkflowGuard.decide(step.when, statuses, blackboard);
        if (!verdict.run) {
          settled.push({ id, status: 'skipped', error: verdict.reason });
          continue;
        }
        const otherBlockers = blockedBy.filter((dep) => dep !== step.when?.step);
        if (otherBlockers.length > 0) {
          settled.push({ id, status: 'blocked', error: blockedReason(otherBlockers) });
          continue;
        }
        runnable.push(id);
        continue;
      }
      if (blockedBy.length > 0) {
        settled.push({ id, status: 'blocked', error: blockedReason(blockedBy) });
        continue;
      }
      runnable.push(id);
    }
    return { runnable, settled };
  }
}
