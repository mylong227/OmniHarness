import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { SubagentPortsShape } from '../../../subagent/subagentPorts.js';
import {
  WorkflowRunner,
  DEFAULT_WORKFLOW_CONCURRENCY,
  WorkflowCycleError,
  WorkflowSpecError,
} from '../../../autonomy/workflowRunner.js';
import type { WorkflowDef } from '../../../autonomy/workflowTypes.js';
import { RUN_WORKFLOW_TOOL_NAME } from '../../../autonomy/workflowToolNames.js';

/** 模型面 run_workflow 工具：派生一次进程内 DAG 工作流（多步依赖编排）。 */
export class RunWorkflowTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: RUN_WORKFLOW_TOOL_NAME,
    description:
      '派生一次进程内 DAG 工作流：多步任务按依赖关系并发编排，前序产出注入后续步骤。适合可拆成有依赖的子任务、需并行推进的复合任务。',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description:
            '工作流定义：{ steps: [{ id, prompt, dependsOn?, tools? }], maxConcurrency? }。dependsOn 为依赖的步骤 id 列表。',
        },
      },
      required: ['spec'],
    },
  };

  /**
   * @param ports 子智能体端口束（工作流各步骤以受限会话运行所需依赖）。
   */
  public constructor(private readonly ports: SubagentPortsShape) {}

  /** 校验并运行工作流。
   * @param call 工具调用（实参含 spec 工作流定义）。
   * @param context 工具上下文（本工具读其 signal：父会话取消信号，用于下传子步）。
   * @returns 执行结果：spec 非法/含环/步骤失败/父取消返回失败；成功附各步骤结果渲染文本。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const spec = call.arguments['spec'];
    if (
      spec === undefined ||
      typeof spec !== 'object' ||
      !Array.isArray((spec as Partial<WorkflowDef>).steps)
    ) {
      return { callId: call.id, ok: false, error: '缺少工作流定义: spec.steps（数组）' };
    }
    const def = spec as WorkflowDef;
    if (def.steps.length === 0) {
      return { callId: call.id, ok: false, error: '工作流至少需包含一个步骤' };
    }
    try {
      const runner = new WorkflowRunner(this.ports, {
        // 非法 maxConcurrency 由 WorkflowRunner 构造期 fail-closed 拒绝（下方 catch 转为工具错误），
        // 绝不留给并发闸门永久挂起。
        maxConcurrency: def.maxConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY,
        // 取消传播：父会话取消 → 不再启动新步骤，在飞步骤的模型请求一并中止。
        signal: context.signal,
      });
      const result = await runner.run(def);
      // `run()` 正常返回 ≠ 全部步骤成功：成败事实是 `result.ok`（含「上游依赖失败被跳过」的传递失败）。
      // 失败时把同一份渲染文本放进 `error`——`ContextAssembler.toolContentOf` 对 ok=false 只渲染
      // error，放进 output 模型就看不到失败原因（语义与同族 `subagentTool` 的失败分支对齐）。
      const rendered = this.render(result);
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

  /** 渲染工作流结果为带元信息的文本。
   * @param result 工作流运行结果（整体成败 + 各步骤明细）。
   * @returns 首行总体状态 + 每步骤一行（成功带输出、失败带原因）。
   */
  private render(result: {
    readonly ok: boolean;
    readonly steps: readonly {
      readonly id: string;
      readonly ok: boolean;
      readonly output?: string | undefined;
      readonly error?: string | undefined;
    }[];
  }): string {
    const head = result.ok ? '工作流全部完成' : '工作流存在失败步骤';
    const lines = result.steps.map((step) =>
      step.ok ? `[${step.id}] ✅ ${step.output ?? ''}` : `[${step.id}] ❌ ${step.error ?? '失败'}`,
    );
    return `${head}\n${lines.join('\n')}`;
  }
}
