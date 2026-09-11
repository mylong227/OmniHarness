import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { TodoPort } from '../../ports/todo.js';

/**
 * @beta
 * `todo_read`：读取当前待办清单快照。
 */
export class TodoReadTool {
  public readonly definition: ToolDefinition = {
    name: 'todo_read',
    description: '读取当前待办清单的最新快照（由 todo_write 维护）。',
    parameters: { type: 'object', properties: {} },
  };

  public constructor(private readonly port: TodoPort) {}

  public async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const items = this.port.list();
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify(items),
    };
  }
}
