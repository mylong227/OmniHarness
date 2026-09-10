import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';
import { PatchApplier } from './patchApplier.js';

/** 应用补丁工具：unified diff 写入工作区文件（失败不改动原文件）。 */
export class ApplyPatchTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'apply_patch',
    description: '应用 unified diff 补丁到工作区文件（校验失败不改动原文件）',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'unified diff 内容' },
        path: { type: 'string', description: '目标文件路径（可省略，缺省取 +++ 头）' },
      },
      required: ['patch'],
    },
  };

  private readonly applier = new PatchApplier();

  public constructor(private readonly workspaceRoot: string) {}

  /** 应用补丁。 */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const patch = String(call.arguments['patch'] ?? '');
    const parsed = this.applier.parse(patch);
    const target = this.resolveTarget(call, parsed);
    if (target === undefined) {
      return {
        callId: call.id,
        ok: false,
        error: 'patch 缺少目标文件（请提供 path 参数或 +++ 头）',
      };
    }
    const guard = new WorkspaceGuard(this.workspaceRoot);
    if (!guard.isInside(target)) {
      return { callId: call.id, ok: false, error: `路径越界: ${target}` };
    }
    const absolute = resolve(this.workspaceRoot, target);
    try {
      const original = await this.readExisting(absolute);
      const result = this.applier.apply(original, patch);
      if (!result.ok) {
        return { callId: call.id, ok: false, error: `补丁应用失败: ${result.error}` };
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, result.newContent ?? '', 'utf8');
      return { callId: call.id, ok: true, output: `补丁已应用到 ${target}` };
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /** 解析目标文件（显式 path 优先，否则取 patch 的 +++ 头）。 */
  private resolveTarget(
    call: ToolCall,
    parsed: { ok: true; targetFile: string } | { ok: false; error: string },
  ): string | undefined {
    const explicit = call.arguments['path'];
    if (typeof explicit === 'string' && explicit !== '') {
      return explicit;
    }
    return parsed.ok ? parsed.targetFile : undefined;
  }

  /** 读取已有文件（不存在视为空）。 */
  private async readExisting(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return '';
    }
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
