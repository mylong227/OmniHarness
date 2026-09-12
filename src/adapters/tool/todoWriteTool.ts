import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { EventPort } from '../../ports/eventPort.js';
import type { TodoItem, TodoPort, TodoStatus } from '../../ports/todo.js';
import type { EventFactoryPort } from '../../ports/eventFactory.js';

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * @beta
 * `todo_write`：全量替换待办列表（last-write-wins），并广播 `todo` 事件。
 * 对标 dsh `packages/todo/tool-todo` 的 `todo/write`。
 */
export class TodoWriteTool {
  public readonly definition: ToolDefinition = {
    name: 'todo_write',
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

  public async handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const raw = call.arguments['todos'];
    if (!Array.isArray(raw)) {
      return { callId: call.id, ok: false, error: 'todos 必须是数组' };
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
    this.port.snapshot(items);
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
