import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { SubagentOrchestrator } from '../../../subagent/subagentOrchestrator.js';
import type { SubagentResult } from '../../../subagent/subagentTypes.js';

/** 主会话派生子智能体时所在的深度（第一层子智能体为 1）。 */
const ROOT_DEPTH = 1;

/**
 * @beta
 * 子智能体工具：模型可派生一个进程内子智能体独立完成子任务。
 */
export class SubagentTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
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

  /**
   * @param orchestrator 子智能体编排器（独立会话创建与受限工具注入均经它）。
   */
  public constructor(private readonly orchestrator: SubagentOrchestrator) {}

  /** 派生并执行子任务。
   * @param call 工具调用（实参含 task，可选 tools）。
   * @param context 工具上下文（取 sessionId 作为父会话）。
   * @returns 执行结果：成功附子智能体输出与元信息；缺 task 或子执行失败返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
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

  /** 渲染结果为带元信息的文本（子会话 ID 可回溯完整轨迹）。
   * @param result 子智能体运行结果。
   * @returns 首行元信息（会话 ID/步数/耗时）+ 输出文本。
   */
  private render(result: SubagentResult): string {
    const head = `[子智能体 ${result.sessionId}] ${result.steps} 步 / ${result.durationMs}ms`;
    return `${head}\n${result.output}`;
  }

  /** 提取可选的工具白名单。
   * @param call 工具调用（实参可能含 tools 数组）。
   * @returns 合法工具名数组；未提供或全非法时为 undefined（继承默认集）。
   */
  private toolsOf(call: ToolCall): readonly string[] | undefined {
    const raw = call.arguments['tools'];
    if (!Array.isArray(raw)) {
      return undefined;
    }
    const names = raw.filter((entry): entry is string => typeof entry === 'string');
    return names.length > 0 ? names : undefined;
  }
}
