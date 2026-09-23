import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';
import { FileContentLedger } from './fileContentLedger.js';

/** 写文件工具：仅限工作区内，覆盖前自动备份 .bak（可审计）。 */
export class WriteFileTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.writeFile,
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

  /**
   * @param workspaceRoot 工作区根目录（写入目标必须落在其内，越界即拒绝）。
   * @param ledger 内容账本（S1，可选）：覆盖前比对指纹，发现外部改动即拒绝写入。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly ledger?: FileContentLedger,
  ) {}

  /** 写入文件。
   * @param call 工具调用（实参含 path 与 content）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：路径越界或写入失败返回失败；成功覆盖前生成 .bak 备份。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const content = String(call.arguments['content'] ?? '');
    const guard = new WorkspaceGuard(this.workspaceRoot);
    if (!guard.isInside(relative)) {
      return {
        callId: call.id,
        ok: false,
        // 报错做人话：给出当前可写根目录，模型据此改写为相对路径，避免反复试错触发 supervisor 降级。
        error:
          `路径越界: "${relative}" 不在工作区内。工作区根目录为 ${this.workspaceRoot}，` +
          `请改用相对此根目录的路径（例如 examples/plugins/demo-string/index.js）`,
      };
    }
    const absolute = resolve(this.workspaceRoot, relative);
    try {
      const existing = await this.readIfExists(absolute);
      // S1 冲突保护：账本里有该文件、且磁盘内容已背离 ⇒ 改动来自本工具链之外，拒绝覆盖。
      if (existing !== undefined && this.ledger?.changedSince(absolute, existing) === true) {
        return { callId: call.id, ok: false, error: FileContentLedger.conflictMessage(relative) };
      }
      if (existing !== undefined) {
        await writeFile(`${absolute}.bak`, existing, 'utf8');
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
      this.ledger?.remember(absolute, content);
      return { callId: call.id, ok: true, output: `已写入 ${relative}` };
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /**
   * 读取现有内容（用于备份与冲突检测）。
   *
   * @param file 目标文件绝对路径。
   * @returns 文件内容；文件不存在时返回 `undefined`（区别于"存在但为空"）。
   */
  private async readIfExists(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return undefined;
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
