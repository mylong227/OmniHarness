import type { SubagentPorts } from '../subagent/subagentPorts.js';
import { OmniError, ErrorCode } from '../errors.js';
import { Agent } from '../core/agent.js';
import { SubagentRuntimeFactory } from '../subagent/subagentRuntimeFactory.js';
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
export class WorkflowCycleError extends OmniError {
  public constructor() {
    super(ErrorCode.WORKFLOW_CYCLE, '工作流 DAG 存在环（依赖关系无法拓扑排序）');
  }
}

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
  /** 同层最大并发步数。 */
  readonly maxConcurrency?: number;
  /** 节点状态变更回调（可选，供实时进度推送）。 */
  readonly onNodeUpdate?: (update: GraphNodeUpdate) => void;
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
    private readonly ports: SubagentPorts,
    private readonly options: WorkflowRunnerOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY;
  }

  /** 运行工作流 DAG 直到达成或遇环 / 失败传播。 */
  public async run(def: WorkflowDef): Promise<WorkflowResult> {
    const byId = new Map(def.steps.map((step) => [step.id, step]));
    const levels = computeLevels(def.steps);
    const blackboard: Record<string, string> = {};
    const results: WorkflowStepResult[] = [];
    const skipped = new Set<string>();
    // spec 中的 maxConcurrency 优先于构造期默认值。
    const maxConcurrency = def.maxConcurrency ?? this.maxConcurrency;

    for (const level of levels) {
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
        if (out.ok && out.output !== undefined) {
          blackboard[out.id] = out.output;
        } else {
          skipped.add(out.id);
        }
      }
    }

    return { ok: results.every((entry) => entry.ok), steps: results, blackboard };
  }

  /** 执行单步：构造隔离子智能体，注入前序产出，跑一次回合。 */
  private async execute(
    step: WorkflowStep,
    blackboard: Record<string, string>,
  ): Promise<WorkflowStepResult> {
    const startedAt = Date.now();
    this.options.onNodeUpdate?.({ id: step.id, status: 'running' });
    try {
      const bridge = new SubagentEventBridge();
      const runtime = SubagentRuntimeFactory.build(
        this.ports,
        this.toolViewOf(step),
        bridge,
        this.ports.maxSteps,
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

  /** 构造带前序产出的提示词。 */
  private promptFor(step: WorkflowStep, blackboard: Record<string, string>): string {
    const deps = step.dependsOn ?? [];
    if (deps.length === 0) {
      return step.prompt;
    }
    const context = deps.map((dep) => `[${dep}]\n${blackboard[dep] ?? '（无产出）'}`).join('\n\n');
    return `${step.prompt}\n\n已有上下文（前序步骤产出）：\n${context}`;
  }

  /** 工具视图：白名单裁剪，剔除 run_workflow/run_goal/subagent 防递归。 */
  private toolViewOf(step: WorkflowStep): ToolSubset {
    const names = step.tools ?? this.ports.tools.list().map((definition) => definition.name);
    const allowed = new Set(
      names.filter(
        (name) => name !== RUN_WORKFLOW_TOOL_NAME && name !== 'run_goal' && name !== 'subagent',
      ),
    );
    return new ToolSubset(this.ports.tools, allowed);
  }
}

/**
 * @beta
 * 拓扑分层（Kahn 算法）：返回按依赖顺序排列的层级（同层步骤互不依赖，可并发）。
 * 存在环时抛 {@link WorkflowCycleError}（fail-closed，不偷偷按错误顺序跑）。
 */
export function computeLevels(steps: readonly WorkflowStep[]): readonly (readonly string[])[] {
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
  let current = steps.filter((step) => (step.dependsOn?.length ?? 0) === 0).map((step) => step.id);
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
