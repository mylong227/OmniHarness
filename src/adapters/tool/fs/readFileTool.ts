import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';
import { FileContentLedger } from './fileContentLedger.js';
import { FileLineWindow } from './fileLineWindow.js';
import type { LineWindowResult } from './fileLineWindow.js';

/**
 * 内置读文件工具：仅允许读取工作区内文件。
 *
 * 2026-09-19 起支持**定点读取 + 行号**（原实现只能整文件返回纯文本，见 {@link FileLineWindow}
 * 的类注释：那正是本仓「读不给行号、改却要行号」复合故障的源头）。
 * 返回文本末尾会附一行定位脚注（`[文件共 N 行；本次返回 X-Y]`），
 * 让模型明确知道是否读全，而不是把「读到一半」当成「文件就这些内容」。
 */
export class ReadFileTool {
  /**
   * @param ledger 内容账本（S1，可选）：成功读取即记录指纹，供写类工具做冲突检测。
   */
  public constructor(private readonly ledger?: FileContentLedger) {}

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'read_file',
    description:
      '读取工作区内的文件内容（默认带行号，可用 offset/limit 定点读取大文件而不必整读）。' +
      '行号即真实行号，可直接用于 apply_patch 的 @@ 头；edit 工具会自动忽略行号前缀。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        offset: { type: 'number', description: '起始行号，从 1 开始（默认 1）' },
        limit: {
          type: 'number',
          description: `最多读取多少行（默认 ${FileLineWindow.DEFAULT_LINES}，上限 ${FileLineWindow.MAX_LINES}）`,
        },
        numbered: {
          type: 'boolean',
          description: '是否输出行号前缀（默认 true；设为 false 得到与文件逐字一致的原文）',
        },
      },
      required: ['path'],
    },
  };

  /** 读取文件。
   * @param call 工具调用（实参含 path，可选 offset / limit / numbered）。
   * @param context 工具上下文（workspaceRoot 为路径白名单基准）。
   * @returns 执行结果：成功附行窗口文本与定位脚注；越界或读取失败返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const guard = new WorkspaceGuard(context.workspaceRoot);
    if (!guard.isInside(relative)) {
      return {
        callId: call.id,
        ok: false,
        error:
          `路径越界: "${relative}" 不在工作区内。工作区根目录为 ${context.workspaceRoot}，` +
          '请改用相对此根目录的路径。',
      };
    }
    const absolute = resolve(context.workspaceRoot, relative);
    try {
      const content = await readFile(absolute, 'utf8');
      // S1：记录"我们已知的最新内容"，让后续写类工具能发现外部改动（冲突保护）。
      this.ledger?.remember(absolute, content);
      const window = FileLineWindow.slice(content, {
        ...(typeof call.arguments['offset'] === 'number'
          ? { offset: call.arguments['offset'] }
          : {}),
        ...(typeof call.arguments['limit'] === 'number' ? { limit: call.arguments['limit'] } : {}),
        ...(call.arguments['numbered'] === false ? { numbered: false } : {}),
      });
      if (window.pastEnd) {
        return {
          callId: call.id,
          ok: false,
          error: `offset=${window.startLine} 已越过文件末尾（${relative} 共 ${window.totalLines} 行）`,
        };
      }
      return { callId: call.id, ok: true, output: this.render(relative, window) };
    } catch (error) {
      return this.failure(call.id, error);
    }
  }

  /**
   * 组织正文与定位脚注。
   *
   * @param relative 目标文件相对路径。
   * @param window 取行结果。
   * @returns 正文 + `[文件共 N 行；本次返回 X-Y]` 脚注（整文件读全时也保留，便于模型确认）。
   */
  private render(relative: string, window: LineWindowResult): string {
    if (window.totalLines === 0) {
      return `${window.text}[${relative} 是空文件（共 0 行）]`;
    }
    const more = window.truncated ? `；还有 ${window.totalLines - window.endLine} 行未返回` : '';
    return `${window.text}\n[${relative} 共 ${window.totalLines} 行；本次返回 ${window.startLine}-${window.endLine}${more}]`;
  }

  /** 构造失败结果。
   * @param callId 工具调用 ID。
   * @param error 抛出的错误（Error 或任意值）。
   * @returns ok=false 的工具结果（错误消息已提取）。
   */
  private failure(callId: string, error: unknown): ToolResult {
    const detail = error instanceof Error ? error.message : String(error);
    return { callId, ok: false, error: detail };
  }
}
