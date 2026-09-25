import { TOOL_NAMES } from '../ports/tool/toolNames.js';
import { WorkflowCycleError } from './workflowCycleError.js';
import { WorkflowSpecError } from './workflowSpecError.js';
import type { SubagentPortsShape } from '../subagent/subagentPorts.js';
import { CANCELLED_BY_PARENT_MESSAGE } from '../subagent/subagentTypes.js';
import { Agent } from '../core/agent.js';
import { subagentRuntimeFactory } from '../subagent/subagentRuntimeFactory.js';
import { SubagentEventBridge } from '../subagent/subagentEventBridge.js';
import { ToolSubset } from '../subagent/toolSubset.js';
import { ConcurrencyLimiter } from '../util/concurrencyLimiter.js';
import type {
  WorkflowDef,
  WorkflowResult,
  WorkflowStep,
  WorkflowStepResult,
} from './workflowTypes.js';
import { RUN_WORKFLOW_TOOL_NAME } from './workflowToolNames.js';

/**
 * @beta
 * 工作流默认同层并发上限。
 */
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;

/**
 * @beta
 * 工作流 DAG 中存在环。
 */

/**
 * @beta
 * 单节点实时状态（供 Web 编排视图与 graph.progress 通知）。
 */
export type GraphNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * @beta
 * 节点状态变更事件。
 */
export interface GraphNodeUpdate {
  /** 步骤 ID。 */
  readonly id: string;
  /** 新状态。 */
  readonly status: GraphNodeStatus;
  /** 失败/跳过原因。 */
  readonly error?: string;
  /** 子智能体步数（done 时有效）。 */
  readonly steps?: number;
  /** 耗时（毫秒）。 */
  readonly durationMs?: number;
}

/**
 * @beta
 * WorkflowRunner 选项。
 */
export interface WorkflowRunnerOptions {
  /** 同层最大并发步数（须为 ≥1 的整数；非法即抛 {@link WorkflowSpecError}）。 */
  readonly maxConcurrency?: number | undefined;
  /** 节点状态变更回调（可选，供实时进度推送）。 */
  readonly onNodeUpdate?: ((update: GraphNodeUpdate) => void) | undefined;
  /**
   * 父会话取消信号（可选）：置位后不再启动新步骤，并把在飞步骤的模型请求一并中止
   * （子代 runtime 的模型端口按此信号协作式取消）。缺省 undefined＝不传播取消。
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * @beta
 * 工作流 DAG 编排器（对标 dsh agent-team / workflow DAG）：
 * 把多步任务组织为有向无环图，按拓扑层级调度——同层并发（受 {@link DEFAULT_WORKFLOW_CONCURRENCY} 闸门约束），
 * 前序步骤产出经 blackboard 注入后续步骤 prompt；某步失败则其全部下游 fail-closed 跳过（绝不静默续跑）。
 *
 * 复用 {@link Agent} 主循环意味着每步自动继承上下文压缩、工具结果外溢、FFI 原生后端等全部既有能力，
 * 本类只负责「DAG 调度 + 依赖注入 + 失败传播」——与 #76 子智能体同一思路，零重复实现。
 */
export class WorkflowRunner {
  private readonly maxConcurrency: number;

  public constructor(
    private readonly ports: SubagentPortsShape,
    private readonly options: WorkflowRunnerOptions = {},
  ) {
    // 非法并发上限 fail-closed：非法值会让闸门永不放行（调用方永久挂起），
    // 故在构造期就拒绝并给出可执行信息，而不是留给 run() 挂死。
    this.maxConcurrency = WorkflowSpecError.requireWorkflowConcurrency(
      options.maxConcurrency,
      DEFAULT_WORKFLOW_CONCURRENCY,
    );
  }

  /**
   * 运行工作流 DAG 直到达成或遇环 / 失败传播 / 父会话取消。
   * @param def 工作流定义（步骤 DAG + 可选并发上限）
   * @returns 各步骤结果与整体状态
   */
  public async run(def: WorkflowDef): Promise<WorkflowResult> {
    const byId = new Map(def.steps.map((step) => [step.id, step]));
    const levels = WorkflowRunner.computeLevels(def.steps);
    const blackboard: Record<string, string> = {};
    const results: WorkflowStepResult[] = [];
    const skipped = new Set<string>();
    // spec 中的 maxConcurrency 优先于构造期默认值（非法值同样 fail-closed 拒绝）。
    const maxConcurrency = WorkflowSpecError.requireWorkflowConcurrency(
      def.maxConcurrency,
      this.maxConcurrency,
    );

    for (const level of levels) {
      // 父会话已取消：本层及其后所有步骤不再启动（不继续烧 token / 不留孤儿步骤）。
      if (this.isCancelled()) {
        this.cancelRemaining(level, results, skipped);
        continue;
      }
      // 依赖已失败/跳过的步骤本层也跳过（失败传播）。
      for (const id of level) {
        const step = byId.get(id)!;
        if ((step.dependsOn ?? []).some((dep) => skipped.has(dep))) {
          skipped.add(id);
          this.options.onNodeUpdate?.({ id, status: 'skipped', error: '上游依赖失败，已跳过' });
          results.push({
            id,
            ok: false,
            error: '上游依赖失败，已跳过',
            steps: 0,
            durationMs: 0,
          });
        }
      }
      const runnable = level.filter((id) => !skipped.has(id));
      if (runnable.length === 0) {
        continue;
      }
      const limiter = new ConcurrencyLimiter(maxConcurrency);
      const outs = await Promise.all(
        runnable.map((id) => limiter.run(() => this.execute(byId.get(id)!, blackboard))),
      );
      for (const out of outs) {
        results.push(out);
        // 失败才阻塞下游；**成功但无产出**（finalText 为 undefined）只是「没有内容可注入下游」，
        // 若把它并入失败集合，下游会被 fail-closed 跳过、整体 ok 变 false——等于把
        // 「这一步没吐文本」误判成「这一步失败了」，并把假故障一路传染给全部下游。
        if (!out.ok) {
          skipped.add(out.id);
        } else if (out.output !== undefined) {
          blackboard[out.id] = out.output;
        }
      }
    }

    return { ok: results.every((entry) => entry.ok), steps: results, blackboard };
  }

  /**
   * 父会话是否已取消（未注入取消信号时恒为 false）。
   * @returns 已取消为 true
   */
  private isCancelled(): boolean {
    return this.options.signal?.aborted === true;
  }

  /**
   * 把本层尚未执行的步骤记为「已取消」并阻塞其下游（取消传播，绝不静默续跑）。
   * @param level 当前拓扑层的步骤 id 列表
   * @param results 结果收集数组（就地追加取消结果）
   * @param skipped 失败/跳过集合（就地标记，使下游继续被阻塞）
   * @returns 无返回值
   */
  private cancelRemaining(
    level: readonly string[],
    results: WorkflowStepResult[],
    skipped: Set<string>,
  ): void {
    for (const id of level) {
      if (skipped.has(id)) {
        continue;
      }
      skipped.add(id);
      this.options.onNodeUpdate?.({ id, status: 'skipped', error: CANCELLED_BY_PARENT_MESSAGE });
      results.push({
        id,
        ok: false,
        error: CANCELLED_BY_PARENT_MESSAGE,
        steps: 0,
        durationMs: 0,
      });
    }
  }

  /**
   * 执行单步：构造隔离子智能体，注入前序产出，跑一次回合。
   * @param step 待执行步骤
   * @param blackboard 前序步骤的黑板产出（按步骤 id 索引）
   * @returns 单步结果（输出/状态/耗时）
   */
  private async execute(
    step: WorkflowStep,
    blackboard: Record<string, string>,
  ): Promise<WorkflowStepResult> {
    const startedAt = Date.now();
    this.options.onNodeUpdate?.({ id: step.id, status: 'running' });
    try {
      const bridge = new SubagentEventBridge();
      const runtime = subagentRuntimeFactory.build(
        this.ports,
        this.toolViewOf(step),
        bridge,
        this.ports.maxSteps,
        // 取消传播：父会话取消 → 本步子代的在飞模型请求一并中止。
        this.options.signal,
      );
      const outcome = await new Agent(runtime).runTask(this.promptFor(step, blackboard));
      const durationMs = Date.now() - startedAt;
      this.options.onNodeUpdate?.({
        id: step.id,
        status: 'done',
        steps: outcome.steps,
        durationMs,
      });
      return {
        id: step.id,
        ok: true,
        output: outcome.finalText,
        steps: outcome.steps,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.options.onNodeUpdate?.({ id: step.id, status: 'failed', error: message, durationMs });
      return {
        id: step.id,
        ok: false,
        error: message,
        steps: 0,
        durationMs,
      };
    }
  }

  /**
   * 构造带前序产出的提示词。
   * @param step 当前步骤
   * @param blackboard 前序产出（仅取 dependsOn 引用的条目）
   * @returns 注入依赖产出后的提示词
   */
  private promptFor(step: WorkflowStep, blackboard: Record<string, string>): string {
    const deps = step.dependsOn ?? [];
    if (deps.length === 0) {
      return step.prompt;
    }
    const context = deps.map((dep) => `[${dep}]\n${blackboard[dep] ?? '（无产出）'}`).join('\n\n');
    return `${step.prompt}\n\n已有上下文（前序步骤产出）：\n${context}`;
  }

  /**
   * 把工作流步骤投给模型可读的工具视图（隐藏实现细节，仅暴露名称/意图）。
   * @param step 工作流步骤
   * @returns 单行摘要文本
   */
  private toolViewOf(step: WorkflowStep): ToolSubset {
    const names = step.tools ?? this.ports.tools.list().map((definition) => definition.name);
    const allowed = new Set(
      names.filter(
        (name) =>
          name !== RUN_WORKFLOW_TOOL_NAME &&
          name !== TOOL_NAMES.runGoal &&
          name !== TOOL_NAMES.subagent,
      ),
    );
    return new ToolSubset(this.ports.tools, allowed);
  }

  /**
   * @beta
   * 拓扑分层（Kahn 算法）：返回按依赖顺序排列的层级（同层步骤互不依赖，可并发）。
   * 存在环时抛 {@link WorkflowCycleError}（fail-closed，不偷偷按错误顺序跑）。
   */
  public static computeLevels(steps: readonly WorkflowStep[]): readonly (readonly string[])[] {
    const byId = new Map(steps.map((step) => [step.id, step]));
    if (new Set(steps.map((step) => step.id)).size !== steps.length) {
      throw new WorkflowCycleError();
    }
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const step of steps) {
      indegree.set(step.id, step.dependsOn?.length ?? 0);
      for (const dep of step.dependsOn ?? []) {
        if (!byId.has(dep)) {
          throw new WorkflowCycleError();
        }
        dependents.set(dep, [...(dependents.get(dep) ?? []), step.id]);
      }
    }
    const levels: string[][] = [];
    let current = steps
      .filter((step) => (step.dependsOn?.length ?? 0) === 0)
      .map((step) => step.id);
    // 种子层（无依赖的起点）同样计入已访问，否则会漏算导致误判成环。
    const visited = new Set<string>(current);
    while (current.length > 0) {
      levels.push(current);
      const next: string[] = [];
      for (const id of current) {
        for (const dependent of dependents.get(id) ?? []) {
          const remaining = (indegree.get(dependent) ?? 0) - 1;
          indegree.set(dependent, remaining);
          if (remaining === 0 && !visited.has(dependent)) {
            visited.add(dependent);
            next.push(dependent);
          }
        }
      }
      current = next;
    }
    if (visited.size !== steps.length) {
      throw new WorkflowCycleError();
    }
    return levels;
  }
}

export { WorkflowCycleError };
export { WorkflowSpecError };
