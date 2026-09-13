import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { WorkerOrchestrator } from '../../../worker/workerOrchestrator.js';

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

  /**
   * @param orchestrator 外部 worker 编排器（委派、审批与事件流复用主会话链路）。
   */
  public constructor(private readonly orchestrator: WorkerOrchestrator) {}

  /** 委派任务。
   * @param call 工具调用（实参含 worker 与 task）。
   * @param context 工具上下文（workspaceRoot 传给 worker 作执行目录）。
   * @returns 执行结果：worker 输出加名称前缀；委派异常返回失败。
   */
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

  /** 提取错误消息。
   * @param error 抛出的任意值。
   * @returns Error 取 message，其余转字符串。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
