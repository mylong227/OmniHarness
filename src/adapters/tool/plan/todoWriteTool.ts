import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import type { EventPort } from '../../../ports/runtime/eventPort.ts';
import type { TodoItem, TodoPort, TodoStatus } from '../../../ports/runtime/todo.ts';
import type { EventFactoryPort } from '../../../ports/runtime/eventFactory.ts';

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * @beta
 * `todo_write`：全量替换待办列表（last-write-wins），并广播 `todo` 事件。
 * 对标 dsh `packages/todo/tool-todo` 的 `todo/write`。
 */
export class TodoWriteTool {
  /**
   * 工具定义：todo_write 工具的名称、描述与参数 schema。
   * 全量替换待办列表（last-write-wins）并广播 todo 事件，用于长任务进度可控。
   */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.todoWrite,
    description:
      '维护当前任务的待办清单：每次调用传入完整列表（整表替换，last-write-wins）。' +
      '用 in_progress 标记正在做的项，completed 标记已完成的项，帮助长任务保持进度可控。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            '完整待办列表；每项是 { content: 一句话任务, status: pending|in_progress|completed }。',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务描述' },
              status: { type: 'string', description: 'pending | in_progress | completed' },
            },
          },
        },
      },
      required: ['todos'],
    },
  };

  public constructor(
    private readonly port: TodoPort,
    private readonly events: EventPort | undefined,
    private readonly eventFactory: EventFactoryPort,
  ) {}

  /** 单次待办上限：防止模型把上百条噪声塞进 UI/上下文（超出即拒绝，而不是静默截断）。 */
  private static readonly MAX_ITEMS = 20;

  /**
   * 执行 todo_write：校验并整表替换待办、广播 todo 事件、汇总各状态计数。
   * @param call 模型传入的工具调用（含完整 todos 数组）。
   * @param ctx 工具执行上下文（取 sessionId 用于广播 todo 事件）。
   * @returns todos 非数组、content 为空、status 非法、超过上限或同时多个 in_progress 时报错。
   */
  public async handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const raw = call.arguments['todos'];
    if (!Array.isArray(raw)) {
      return { callId: call.id, ok: false, error: 'todos 必须是数组' };
    }
    if (raw.length > TodoWriteTool.MAX_ITEMS) {
      return {
        callId: call.id,
        ok: false,
        error: `todos 最多 ${String(TodoWriteTool.MAX_ITEMS)} 条（当前 ${String(raw.length)} 条），请合并或拆分任务`,
      };
    }
    const items: TodoItem[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const entry = raw[i] as Record<string, unknown>;
      const content = typeof entry['content'] === 'string' ? (entry['content'] as string) : '';
      const status = entry['status'] as TodoStatus;
      if (content.length === 0) {
        return { callId: call.id, ok: false, error: `todos[${i}].content 不能为空` };
      }
      if (!STATUSES.includes(status)) {
        return {
          callId: call.id,
          ok: false,
          error: `todos[${i}].status 必须是 pending|in_progress|completed`,
        };
      }
      items.push({ content, status });
    }
    if (items.filter((item) => item.status === 'in_progress').length > 1) {
      return {
        callId: call.id,
        ok: false,
        error: '同一时刻最多只能有一条 in_progress；请先完成当前步骤再推进下一条',
      };
    }
    // 按**本会话**写入（2026-09-26 审计 F7/F9）：待办端口是进程级单例，不分桶时子代理的
    // todo_write 会整表覆盖父会话的清单。
    this.port.snapshot(items, ctx.sessionId);
    this.events?.emit(this.eventFactory.todo(ctx.sessionId, items));
    const counts = items.reduce(
      (acc, it) => {
        acc[it.status] += 1;
        return acc;
      },
      { pending: 0, in_progress: 0, completed: 0 } as Record<TodoStatus, number>,
    );
    return {
      callId: call.id,
      ok: true,
      output: `已写入 ${items.length} 条待办：pending ${counts.pending} / in_progress ${counts.in_progress} / completed ${counts.completed}`,
    };
  }
}
