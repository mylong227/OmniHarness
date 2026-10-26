import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import { WorkspaceGuard } from '../../../util/workspaceGuard.ts';
import { FileContentLedger } from './fileContentLedger.ts';
import { FileLineWindow } from './fileLineWindow.ts';
import type { LineWindowResult } from './fileLineWindow.ts';
import { WorkspaceFileCoordinator } from './workspaceFileCoordinator.ts';

/** 读入内存的字节硬上限（64 MiB；2026-10-03 修，审计 T1）：此前 readFile 无任何上界，
 *  模型对巨型日志/构建产物调 read_file 可能把数 GB 灌进内存（OOM）。与 grepTool 的
 *  2 MiB 扫描上界口径不同——本工具读全量才能取行/记账，上限放宽但仍封顶。 */
const MAX_READ_FILE_BYTES = 64 * 1024 * 1024;

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
    name: TOOL_NAMES.readFile,
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
    const coordinator = WorkspaceFileCoordinator.of(context.workspaceRoot);
    const ledger = this.ledger ?? coordinator.ledger;
    try {
      return await coordinator.withRead(
        absolute,
        (lease) => this.readWithin(call, relative, absolute, context, lease, ledger),
        { ...(context.signal !== undefined ? { signal: context.signal } : {}) },
      );
    } catch (error) {
      return this.failure(call.id, relative, error);
    }
  }

  /**
   * 在读锁内完成「stat → 读取 → 二进制嗅探 → 记账 → 行窗口」。
   *
   * @param call 工具调用。
   * @param relative 目标相对路径。
   * @param absolute 目标绝对路径。
   * @param context 工具上下文。
   * @param lease 读租约（单飞读入口）。
   * @param ledger 内容账本（记录本会话基线）。
   * @returns 工具结果。
   */
  private async readWithin(
    call: ToolCall,
    relative: string,
    absolute: string,
    context: ToolContext,
    lease: { readText(maxBytes?: number): Promise<string> },
    ledger: FileContentLedger,
  ): Promise<ToolResult> {
    // 护栏一（2026-10-03 修，审计 T1）：先 stat 再读。① 拒绝非常规文件；② 拒绝超上限的
    // 巨型文件（旧实现 `readFile(utf8)` 无上界，对 dist/bundle.min.js 之类单行 20MB+ 或
    // 数 GB 日志会整读进内存 + 算 sha1，可 OOM；即使外溢，spill_read 豁免名单也会让全文
    // 再次进入模型上下文）。字节预算内的输出截断由 FileLineWindow.MAX_WINDOW_BYTES 负责。
    const info = await stat(absolute);
    if (!info.isFile()) {
      return {
        callId: call.id,
        ok: false,
        error: `不是常规文件: ${relative}（目录/设备等请用 list_dir / shell）`,
      };
    }
    if (info.size > MAX_READ_FILE_BYTES) {
      return {
        callId: call.id,
        ok: false,
        error:
          `文件过大: ${relative} 共 ${String(Math.round(info.size / 1048576))} MiB，` +
          `超过读取上限 ${String(Math.round(MAX_READ_FILE_BYTES / 1048576))} MiB。` +
          '请改用 grep 定位关键内容，或用 shell（如 head/dd/split）按需取片段。',
      };
    }
    const content = await lease.readText(MAX_READ_FILE_BYTES);
    // 护栏二：二进制嗅探（前 8 KiB 出现 NUL 即判二进制，与 grepTool 同口径）。
    // 把二进制当文本解码既产出乱码，也会让行窗口/行号完全失真。
    if (ReadFileTool.hasNulByte(Buffer.from(content.slice(0, 8192), 'utf8'))) {
      return {
        callId: call.id,
        ok: false,
        error:
          `疑似二进制文件: ${relative}（前 8 KiB 含 NUL 字节）。` +
          '图片请用 view_image；确需查看内容请用 shell（如 file/hexdump/strings）。',
      };
    }
    // S1：记录该会话看到的版本，让后续写类工具能发现「本会话读取之后」的外部改动。
    ledger.observe(absolute, content, context.sessionId);
    const window = FileLineWindow.slice(content, {
      ...(typeof call.arguments['offset'] === 'number' ? { offset: call.arguments['offset'] } : {}),
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
   *
   * 2026-10-13 修：此前把 Node 原始错误**裸透传**——`stat` 一个不存在的文件就抛
   * `ENOENT: no such file or directory, stat 'D:\work\…\README.md'`，带着绝对路径直接
   * 打红 UI（实测截图）。现与 editFileTool.readError 同口径：ENOENT 转成对模型可行动的
   * 人话（指向 list_dir / glob 确认文件名、write_file 新建），其余错误仍原样保留细节。
   *
   * @param callId 工具调用 ID。
   * @param relative 目标文件相对路径（用于组织人话文案）。
   * @param error 抛出的错误（Error 或任意值）。
   * @returns ok=false 的工具结果（错误消息已提取）。
   */
  private failure(callId: string, relative: string, error: unknown): ToolResult {
    const detail = error instanceof Error ? error.message : String(error);
    if (/ENOENT|no such file/i.test(detail)) {
      return {
        callId,
        ok: false,
        error:
          `文件不存在: ${relative}（工作区内没有这个文件）。` +
          '可用 list_dir 或 glob 确认实际文件名（注意大小写与扩展名）；' +
          '若是新文件请先用 write_file 创建。',
      };
    }
    if (/EACCES|EPERM|permission denied/i.test(detail)) {
      return {
        callId,
        ok: false,
        error: `无权限读取: ${relative}（操作系统拒绝访问）。可尝试用 shell 确认文件属性。`,
      };
    }
    return { callId, ok: false, error: detail };
  }

  /**
   * 二进制嗅探：缓冲区中出现 NUL 字节即判二进制（与 grepTool.hasNulByte 同口径）。
   * @param buffer 文件头部字节。
   * @returns 含 NUL 字节时 true。
   */
  private static hasNulByte(buffer: Buffer): boolean {
    return buffer.includes(0);
  }
}
