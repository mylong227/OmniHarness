import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/** 内置读文件工具：仅允许读取工作区内文件。 */
export class ReadFileTool {
  /** 工具定义。 */
  readonly definition: ToolDefinition = {
    name: 'read_file',
    description: '读取工作区内的文件内容',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
      },
      required: ['path'],
    },
  };

  /** 读取文件。 */
  async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const guard = new WorkspaceGuard(context.workspaceRoot);
    if (!guard.isInside(relative)) {
      return { callId: call.id, ok: false, error: `路径越界: ${relative}` };
    }
    const absolute = resolve(context.workspaceRoot, relative);
    try {
      const content = await readFile(absolute, 'utf8');
      return { callId: call.id, ok: true, output: content };
    } catch (error) {
      return this.failure(call.id, error);
    }
  }

  /** 构造失败结果。 */
  private failure(callId: string, error: unknown): ToolResult {
    const detail = error instanceof Error ? error.message : String(error);
    return { callId, ok: false, error: detail };
  }
}
