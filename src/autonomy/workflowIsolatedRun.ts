import { WorkflowIsolation } from './workflowIsolation.ts';
import { WorkflowRunner, type WorkflowRunnerOptions } from './workflowRunner.ts';
import type { WorkflowDef, WorkflowResult } from './workflowTypes.ts';
import type { SubagentPortsShape } from '../ports/subagent/subagentPortsShape.ts';

/**
 * 隔离运行外壳（2026-10-29，A5）：worktree 的创建 / 成功应用 / 失败丢弃 / 收尾，
 * 从 `WorkflowRunner.run` 抽出以压体量。
 */
export class WorkflowIsolatedRun {
  /**
   * 在隔离 worktree 中跑完整工作流（成功才把改动应用回主工作区）。
   * @param ports 子智能体端口集（workspaceRoot 指向主工作区）。
   * @param options runner 选项（`persist:true` 暂不支持，会 fail-closed）。
   * @param def 工作流定义。
   * @returns 工作流结果。
   */
  public static async runWorkflow(
    ports: SubagentPortsShape,
    options: WorkflowRunnerOptions,
    def: WorkflowDef,
  ): Promise<WorkflowResult> {
    if (options.persist === true) {
      throw new Error('workflow 隔离暂不支持 persist（运行日志写在工作区外会丢失）');
    }
    return await WorkflowIsolatedRun.run(true, ports.workspaceRoot, async (root) => {
      const runner = new WorkflowRunner({ ...ports, workspaceRoot: root }, options);
      return await runner.run(def);
    });
  }

  /**
   * 在隔离（或非隔离）工作区里执行一次运行。
   * @param isolate 是否启用 worktree 隔离。
   * @param repoRoot 主工作区根。
   * @param body 运行体（收到本次应使用的工作区根）。
   * @returns 运行结果（原样透传）。
   */
  public static async run<T extends { readonly ok: boolean }>(
    isolate: boolean,
    repoRoot: string,
    body: (root: string) => Promise<T>,
  ): Promise<T> {
    const isolation = isolate ? WorkflowIsolation.create(repoRoot) : undefined;
    try {
      const result = await body(isolation?.root ?? repoRoot);
      if (isolation !== undefined) {
        if (result.ok) isolation.commit();
        else isolation.discard();
      }
      return result;
    } finally {
      isolation?.discard();
    }
  }
}
