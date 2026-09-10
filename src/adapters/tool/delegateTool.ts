import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { WorkerOrchestrator } from '../../worker/workerOrchestrator.js';

/**
 * @beta
 * 委派工具：模型把子任务交给外部 harness worker（同一审批/事件流）。
 */
export class DelegateTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'delegate',
    description: '把子任务委派给外部 worker（codex/claude-code/dsh 等）执行，返回结果',
    parameters: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'worker 名称' },
        task: { type: 'string', description: '子任务描述' },
      },
      required: ['worker', 'task'],
    },
  };

  public constructor(private readonly orchestrator: WorkerOrchestrator) {}

  /** 委派任务。 */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const worker = String(call.arguments['worker'] ?? '');
    const task = String(call.arguments['task'] ?? '');
    try {
      const result = await this.orchestrator.delegate({ worker, task }, context.workspaceRoot);
      return { callId: call.id, ok: result.ok, output: `[${worker}] ${result.output}` };
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
