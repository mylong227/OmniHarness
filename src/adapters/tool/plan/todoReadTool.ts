import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { TodoPort } from '../../../ports/runtime/todo.js';

/**
 * @beta
 * `todo_read`：读取当前待办清单快照。
 */
export class TodoReadTool {
  /**
   * 工具定义：todo_read 工具的名称、描述与参数 schema。
   * 读取当前待办清单的最新快照（由 todo_write 维护）。
   */
  public readonly definition: ToolDefinition = {
    name: 'todo_read',
    description: '读取当前待办清单的最新快照（由 todo_write 维护）。',
    parameters: { type: 'object', properties: {} },
  };

  public constructor(private readonly port: TodoPort) {}

  /**
   * 执行 todo_read：返回当前待办列表快照。
   * @param call 模型传入的工具调用（本工具无参数）。
   * @param _ctx 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 始终 ok:true，output 为待办项 JSON 数组。
   */
  public async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const items = this.port.list();
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify(items),
    };
  }
}
