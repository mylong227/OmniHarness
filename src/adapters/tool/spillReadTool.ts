import type { SpillPort } from '../../ports/spill.js';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';

/**
 * @beta
 * 外溢内容读回工具：按外溢 id 取回被外溢的完整工具输出。
 */
export class SpillReadTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'spill_read',
    description: '按 id 读回被外溢的完整工具输出（输出过大时原文已移出上下文，此处可取回全文）',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '外溢 id（形如 spill_xxxx_1）' },
      },
      required: ['id'],
    },
  };

  /**
   * @param port 外溢端口（按 id 读回被移出上下文的完整输出）。
   */
  public constructor(private readonly port: SpillPort) {}

  /** 读回外溢内容。
   * @param call 工具调用（实参含外溢 id）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：成功附完整外溢文本；id 不存在返回失败。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const spillId = String(call.arguments['id'] ?? '');
    const content = await this.port.read(spillId);
    if (content === undefined) {
      return { callId: call.id, ok: false, error: `外溢内容不存在: ${spillId}` };
    }
    return { callId: call.id, ok: true, output: content };
  }
}
