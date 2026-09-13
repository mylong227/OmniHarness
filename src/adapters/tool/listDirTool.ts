import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/** 列目录工具：仅限工作区内，列出条目（名称 + 类型）。 */
export class ListDirTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'list_dir',
    description: '列出工作区内目录条目（名称与类型）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的目录路径（默认 .）' },
      },
    },
  };

  /**
   * @param workspaceRoot 工作区根目录（目录目标必须落在其内，越界即拒绝）。
   */
  public constructor(private readonly workspaceRoot: string) {}

  /** 列出目录。
   * @param call 工具调用（实参可选 path，默认根目录）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：成功附条目列表（`[d]`/`[f]` 前缀）；越界或读取失败返回失败。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '.');
    const guard = new WorkspaceGuard(this.workspaceRoot);
    if (!guard.isInside(relative)) {
      return { callId: call.id, ok: false, error: `路径越界: ${relative}` };
    }
    try {
      const entries = await readdir(resolve(this.workspaceRoot, relative), { withFileTypes: true });
      const lines = entries.map((entry) => `${entry.isDirectory() ? '[d]' : '[f]'} ${entry.name}`);
      return { callId: call.id, ok: true, output: lines.join('\n') };
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
