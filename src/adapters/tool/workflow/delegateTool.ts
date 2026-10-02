import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
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
    name: TOOL_NAMES.delegate,
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
   * @returns 执行结果：worker 输出加名称前缀；worker 失败时**原因同时进 error**（否则模型看不到）；委派异常返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const worker = String(call.arguments['worker'] ?? '');
    const task = String(call.arguments['task'] ?? '');
    try {
      // 取消信号透传（2026-10-01 审计）：`WorkerRequest.signal` 字段存在、且 `CliWorker` 的
      // kill-tree 取消实现是完备的，但父会话的 signal 从未被传进来 —— 于是用户 Ctrl-C /
      // 会话超时后外部 worker 仍跑到自身 30 分钟超时，而 `delegate` 在调度器里是串行屏障，
      // 一个挂死的 worker 会永久阻塞整个回合，且退出后子进程可能成孤儿。
      const result = await this.orchestrator.delegate(
        { worker, task },
        context.workspaceRoot,
        context.signal,
      );
      // worker 失败时**必须同时给 error**：`ContextAssembler` 对 ok=false 只渲染 `error`
      // （`工具执行失败: ${error ?? '未知错误'}`），把原因塞进 output 等于丢掉——实测 worker
      // 的「退出码 1 + stderr」会变成「未知错误」，模型无从自修（任务拆解能力的真实瓶颈）。
      return result.ok
        ? { callId: call.id, ok: true, output: `[${worker}] ${result.output}` }
        : { callId: call.id, ok: false, error: `[${worker}] ${result.output}` };
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
