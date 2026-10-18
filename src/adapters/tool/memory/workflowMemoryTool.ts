import type { WorkflowMemoryPort } from '../../../ports/memory/workflowMemory.ts';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';

/**
 * Workflow Memory 工具（P4）：让模型显式记录/召回「某类任务上一次成功走完的工具序列」。
 *
 * 为什么不自动重放：工具参数与副作用不可无条件复用；这里只给参考轨迹，由模型重新判断。
 * 写入落在工作区 `.omniharness/workflows.jsonl`，有界、可手工删除。
 */
export class WorkflowMemoryTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.workflowMemory,
    description:
      '任务级 workflow 记忆：remember 记录本次成功工具序列；recall 按任务描述召回相似成功轨迹。' +
      '召回只是参考，不自动重放（工具参数/副作用仍需重新判断）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remember', 'recall'], description: '动作' },
        task: { type: 'string', description: '任务描述（recall 时作为查询）' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'remember 时的工具步骤摘要（如 "apply_patch src/x.ts"），1–50 条',
        },
      },
      required: ['action', 'task'],
    },
  };

  /**
   * @param memory workflow 记忆端口
   */
  public constructor(private readonly memory: WorkflowMemoryPort) {}

  /**
   * 执行记忆动作。
   * @param call 工具调用
   * @param _context 工具上下文（本工具不读工作区；保留签名一致）
   * @returns 结果
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const action = String(call.arguments['action'] ?? '');
    const task = String(call.arguments['task'] ?? '').trim();
    if (task === '') {
      return { callId: call.id, ok: false, error: 'task 不能为空' };
    }
    if (action === 'remember') {
      const steps = this.readSteps(call);
      if (typeof steps === 'string') {
        return { callId: call.id, ok: false, error: steps };
      }
      await this.memory.remember(task, steps);
      return {
        callId: call.id,
        ok: true,
        output: `已记录 workflow：${String(steps.length)} 步（任务：${task.slice(0, 80)}）`,
      };
    }
    if (action === 'recall') {
      const entries = await this.memory.recall(task, 3);
      if (entries.length === 0) {
        return { callId: call.id, ok: true, output: '没有找到相似的成功 workflow。' };
      }
      return {
        callId: call.id,
        ok: true,
        output: entries
          .map(
            (entry) =>
              `- ${entry.task.slice(0, 120)}\n  ${entry.steps.map((step) => `→ ${step}`).join(' ')}`,
          )
          .join('\n'),
      };
    }
    return {
      callId: call.id,
      ok: false,
      error: `未知 action：${action}（只支持 remember / recall）`,
    };
  }

  /**
   * 读取 remember 的步骤（1–50 条非空字符串）。
   * @param call 工具调用
   * @returns 步骤数组 / 可读错误
   */
  private readSteps(call: ToolCall): readonly string[] | string {
    const raw = call.arguments['steps'];
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) {
      return 'remember 需要 steps（1–50 条字符串）';
    }
    const steps = raw.map((step) => (typeof step === 'string' ? step.trim() : ''));
    if (steps.some((step) => step === '')) {
      return 'steps 每项必须是非空字符串';
    }
    return steps;
  }
}
