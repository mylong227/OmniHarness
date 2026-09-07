import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { SubagentOrchestrator } from '../../subagent/subagentOrchestrator.js';
import type { SubagentResult } from '../../subagent/subagentTypes.js';

/** 主会话派生子智能体时所在的深度（第一层子智能体为 1）。 */
const ROOT_DEPTH = 1;

/**
 * @beta
 * 子智能体工具：模型可派生一个进程内子智能体独立完成子任务。
 */
export class SubagentTool {
  /** 工具定义。 */
  readonly definition: ToolDefinition = {
    name: 'subagent',
    description:
      '派生一个进程内子智能体独立完成子任务：独立会话、受限工具集、不可再派生子智能体。适合可并行的长任务或需要隔离上下文的试探性任务。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '子任务描述。需自包含——子智能体看不到主会话历史。',
        },
        tools: {
          type: 'array',
          description: '可选：授权给子智能体的工具名列表；不传则继承除 subagent 外的全部工具。',
        },
      },
      required: ['task'],
    },
  };

  constructor(private readonly orchestrator: SubagentOrchestrator) {}

  /** 派生并执行子任务。 */
  async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const task = String(call.arguments['task'] ?? '').trim();
    if (task === '') {
      return { callId: call.id, ok: false, error: '缺少子任务描述: task' };
    }
    const result = await this.orchestrator.run({
      task,
      parentSessionId: context.sessionId,
      depth: ROOT_DEPTH,
      tools: this.toolsOf(call),
    });
    if (!result.ok) {
      return { callId: call.id, ok: false, error: result.error ?? '子智能体执行失败' };
    }
    return { callId: call.id, ok: true, output: this.render(result) };
  }

  /** 渲染结果为带元信息的文本（子会话 ID 可回溯完整轨迹）。 */
  private render(result: SubagentResult): string {
    const head = `[子智能体 ${result.sessionId}] ${result.steps} 步 / ${result.durationMs}ms`;
    return `${head}\n${result.output}`;
  }

  /** 提取可选的工具白名单。 */
  private toolsOf(call: ToolCall): readonly string[] | undefined {
    const raw = call.arguments['tools'];
    if (!Array.isArray(raw)) {
      return undefined;
    }
    const names = raw.filter((entry): entry is string => typeof entry === 'string');
    return names.length > 0 ? names : undefined;
  }
}
