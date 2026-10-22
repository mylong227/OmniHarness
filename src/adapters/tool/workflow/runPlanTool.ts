import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import type { SubagentPortsShape } from '../../../ports/subagent/subagentPortsShape.ts';
import type { TodoItem, TodoPort } from '../../../ports/runtime/todo.ts';
import type { EventPort } from '../../../ports/runtime/eventPort.ts';
import type { EventFactoryPort } from '../../../ports/runtime/eventFactory.ts';
import {
  WorkflowRunner,
  DEFAULT_WORKFLOW_CONCURRENCY,
  WorkflowCycleError,
  WorkflowSpecError,
} from '../../../autonomy/workflowRunner.ts';
import type { WorkflowDef, WorkflowResult } from '../../../autonomy/workflowTypes.ts';
import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';

/**
 * `run_plan`：把当前会话的 todo DAG 交给 WorkflowRunner 执行。
 *
 * 为什么需要它：`todo_write` 只能表达计划，不能执行；模型若按清单逐个手工推进，
 * 既无法并行、也容易漏步。本工具把 `id/dependsOn` 映射成 WorkflowDef，由既有工作流
 * 引擎按拓扑分层并发执行就绪步骤，并把每步终态回写到 todo。
 *
 * 约束：只执行未完成项；无 id 的项按列表顺序自动串行（`auto_N`），避免意外并行写盘；
 * 有 id 但无 dependsOn 的项可并行。
 */
export class RunPlanTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.runPlan,
    description:
      '按当前 todo 计划执行 DAG：把未完成步骤按 id/dependsOn 映射成工作流，拓扑就绪的步骤并发执行，' +
      '每步由独立子代理完成，结束后回写 todo 状态。没有 id 的步骤按清单顺序串行；有 id 且无 dependsOn 的步骤可并行。' +
      '适合已写好带依赖的计划、需要自动并行推进时使用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '可选运行名（默认 todo-plan）' },
      },
      required: [],
    },
  };

  /**
   * @param ports 子智能体端口束（工作流各步使用）。
   * @param todo 待办端口（读取/回写）。
   * @param events 事件端口（回写 todo 快照）。
   * @param eventFactory 事件工厂。
   */
  public constructor(
    private readonly ports: SubagentPortsShape,
    private readonly todo: TodoPort,
    private readonly events: EventPort | undefined,
    private readonly eventFactory: EventFactoryPort,
  ) {}

  /**
   * 执行当前 todo 计划。
   * @param call 工具调用。
   * @param context 工具上下文（sessionId/signal）。
   * @returns 执行结果；空计划/环/运行失败时 ok:false。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const all = this.todo.list(context.sessionId);
    const pending = all
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.status !== 'completed');
    if (pending.length === 0) {
      return { callId: call.id, ok: false, error: '当前没有未完成的 todo 步骤' };
    }
    const steps = RunPlanTool.buildSteps(pending);
    const def: WorkflowDef = {
      name:
        typeof call.arguments['name'] === 'string' ? String(call.arguments['name']) : 'todo-plan',
      steps,
    };
    try {
      const runner = new WorkflowRunner(this.ports, {
        maxConcurrency: DEFAULT_WORKFLOW_CONCURRENCY,
        signal: context.signal,
        persist: true,
      });
      const result = await runner.run(def);
      this.writeBack(context.sessionId, all, pending, steps, result);
      const rendered = RunPlanTool.render(result);
      return result.ok
        ? { callId: call.id, ok: true, output: rendered }
        : { callId: call.id, ok: false, error: rendered };
    } catch (error) {
      if (error instanceof WorkflowCycleError || error instanceof WorkflowSpecError) {
        return { callId: call.id, ok: false, error: error.message };
      }
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 把待办映射为工作流步骤（无 id 的项按顺序串行）。
   * @param pending 未完成项及其原索引。
   * @returns 工作流步骤。
   */
  private static buildSteps(
    pending: readonly { readonly item: TodoItem; readonly index: number }[],
  ): WorkflowDef['steps'] {
    const steps: { id: string; prompt: string; dependsOn?: readonly string[] }[] = [];
    let previous: string | undefined;
    for (const { item, index } of pending) {
      const id = item.id ?? `auto_${String(index + 1)}`;
      const dependsOn =
        item.dependsOn !== undefined
          ? item.dependsOn
          : item.id === undefined && previous !== undefined
            ? [previous]
            : undefined;
      steps.push({
        id,
        prompt: item.content,
        ...(dependsOn !== undefined ? { dependsOn } : {}),
      });
      previous = id;
    }
    return steps;
  }

  /**
   * 把工作流终态回写 todo（done/skipped → completed，其余保持 pending/in_progress）。
   * @param sessionId 会话。
   * @param all 全量待办。
   * @param pending 本次执行的未完成项。
   * @param steps 工作流步骤。
   * @param result 工作流结果。
   * @returns 无返回值。
   */
  private writeBack(
    sessionId: string,
    all: readonly TodoItem[],
    pending: readonly { readonly item: TodoItem; readonly index: number }[],
    steps: WorkflowDef['steps'],
    result: WorkflowResult,
  ): void {
    const statusById = new Map(result.steps.map((step) => [step.id, step.status]));
    const next = all.map((item, index) => {
      const pendingIndex = pending.findIndex((entry) => entry.index === index);
      if (pendingIndex < 0) return item;
      const stepId = steps[pendingIndex]?.id;
      const status = stepId === undefined ? undefined : statusById.get(stepId);
      const done = status === 'done' || status === 'skipped';
      return done ? { ...item, status: 'completed' as const } : item;
    });
    this.todo.snapshot(next, sessionId);
    this.events?.emit(this.eventFactory.todo(sessionId, next));
  }

  /**
   * 渲染工作流结果。
   * @param result 结果。
   * @returns 文本。
   */
  private static render(result: WorkflowResult): string {
    const lines = [`runId=${result.runId}`, result.ok ? '计划执行完成' : '计划执行有失败'];
    for (const step of result.steps) {
      lines.push(
        `- [${step.status}] ${step.id} (${String(step.durationMs)}ms)` +
          (step.error === undefined ? '' : `：${step.error}`),
      );
    }
    return lines.join('\n');
  }
}
