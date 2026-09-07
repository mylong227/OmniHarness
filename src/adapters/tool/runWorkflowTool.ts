import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { SubagentPorts } from '../../subagent/subagentPorts.js';
import {
  WorkflowRunner,
  DEFAULT_WORKFLOW_CONCURRENCY,
  WorkflowCycleError,
} from '../../autonomy/workflowRunner.js';
import type { WorkflowDef } from '../../autonomy/workflowTypes.js';
import { RUN_WORKFLOW_TOOL_NAME } from '../../autonomy/workflowToolNames.js';

/** 模型面 run_workflow 工具：派生一次进程内 DAG 工作流（多步依赖编排）。 */
export class RunWorkflowTool {
  /** 工具定义。 */
  readonly definition: ToolDefinition = {
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

  constructor(private readonly ports: SubagentPorts) {}

  /** 校验并运行工作流。 */
  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
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
        maxConcurrency: def.maxConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY,
      });
      const result = await runner.run(def);
      return { callId: call.id, ok: true, output: this.render(result) };
    } catch (error) {
      if (error instanceof WorkflowCycleError) {
        return { callId: call.id, ok: false, error: error.message };
      }
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 渲染工作流结果为带元信息的文本。 */
  private render(result: {
    readonly ok: boolean;
    readonly steps: readonly {
      readonly id: string;
      readonly ok: boolean;
      readonly output?: string;
      readonly error?: string;
    }[];
  }): string {
    const head = result.ok ? '工作流全部完成' : '工作流存在失败步骤';
    const lines = result.steps.map((step) =>
      step.ok ? `[${step.id}] ✅ ${step.output ?? ''}` : `[${step.id}] ❌ ${step.error ?? '失败'}`,
    );
    return `${head}\n${lines.join('\n')}`;
  }
}
