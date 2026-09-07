import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/** 写文件工具：仅限工作区内，覆盖前自动备份 .bak（可审计）。 */
export class WriteFileTool {
  /** 工具定义。 */
  readonly definition: ToolDefinition = {
    name: 'write_file',
    description: '写入文件内容（工作区内；覆盖已有文件前自动生成 .bak 备份）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '要写入的内容' },
      },
      required: ['path', 'content'],
    },
  };

  constructor(private readonly workspaceRoot: string) {}

  /** 写入文件。 */
  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const content = String(call.arguments['content'] ?? '');
    const guard = new WorkspaceGuard(this.workspaceRoot);
    if (!guard.isInside(relative)) {
      return { callId: call.id, ok: false, error: `路径越界: ${relative}` };
    }
    const absolute = resolve(this.workspaceRoot, relative);
    try {
      await this.backupIfExists(absolute);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
      return { callId: call.id, ok: true, output: `已写入 ${relative}` };
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /** 覆盖前备份原文件。 */
  private async backupIfExists(file: string): Promise<void> {
    try {
      const original = await readFile(file, 'utf8');
      await writeFile(`${file}.bak`, original, 'utf8');
    } catch {
      // 文件不存在则无需备份
    }
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
