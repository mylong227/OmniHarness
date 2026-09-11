import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolResult } from '../../ports/tool.js';
import type { ToolHookContext, ToolHooks } from '../../core/toolHookRunner.js';
import type { TurnDiffTracker } from '../../core/turnDiffTracker.js';

/** 参与变更追踪的写类工具：参数带 `path`，可精确定位目标文件。 */
export const TRACKED_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'apply_patch']);

/**
 * 变更追踪钩子（#M5，对标 codex `TurnDiffTracker` 接入方式）。
 *
 * 写类工具执行前读一次 baseline、执行后取一次快照，喂给 `TurnDiffTracker`，
 * 使回合结束时能产出完整 unified diff，而无需重扫整个工作区。
 *
 * **局限（与 codex 一致）**：只追踪参数带 `path` 的写类工具；shell 直接改文件不在追踪范围，
 * 故 `apply_patch` 省略 `path`（仅靠 patch 头定位）时同样不追踪——宁可不记，也不猜。
 */
export class TurnDiffHooks {
  private readonly baseline = new Map<string, string | null>();

  public constructor(
    private readonly tracker: TurnDiffTracker,
    private readonly workspaceRoot: string,
  ) {}

  /** 产出可注册进 `ToolHookRunner` 的钩子组。 */
  public hooks(): ToolHooks {
    return {
      pre: (context) => this.captureBaseline(context),
      post: (context, result) => this.captureResult(context, result),
    };
  }

  /** 执行前：首次触碰某文件时读一次原始内容作为 baseline（后续同回合再写不覆盖）。 */
  private async captureBaseline(context: ToolHookContext): Promise<void> {
    const path = this.pathOf(context);
    if (path === undefined || this.baseline.has(path)) {
      return;
    }
    this.baseline.set(path, await this.readText(this.absoluteOf(path)));
  }

  /** 执行后：成功才记录；写失败或读不到新内容一律 invalidate（不给不完整的差异）。 */
  private async captureResult(context: ToolHookContext, result: ToolResult): Promise<void> {
    const path = this.pathOf(context);
    if (path === undefined || !result.ok) {
      return;
    }
    const after = await this.afterOf(context, path);
    if (after === null) {
      this.tracker.invalidate();
      return;
    }
    this.tracker.noteWrite(path, this.baseline.get(path) ?? null, after);
  }

  /** 取执行后内容：write_file 直接用入参（省一次 IO），apply_patch 读回磁盘。 */
  private async afterOf(context: ToolHookContext, path: string): Promise<string | null> {
    if (context.toolName === 'write_file') {
      return String(context.args !== undefined ? (context.args['content'] ?? '') : '');
    }
    return this.readText(this.absoluteOf(path));
  }

  /** 提取目标路径（仅追踪参数显式带 path 的写类工具）。 */
  private pathOf(context: ToolHookContext): string | undefined {
    if (!TRACKED_WRITE_TOOLS.has(context.toolName)) {
      return undefined;
    }
    const raw = context.args !== undefined ? context.args['path'] : undefined;
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  }

  /** 相对路径转绝对（工具侧已由 WorkspaceGuard 限界，此处只做拼接）。 */
  private absoluteOf(relative: string): string {
    return resolve(this.workspaceRoot, relative);
  }

  /** 读文本；文件不存在或不可读返回 null。 */
  private async readText(absolute: string): Promise<string | null> {
    try {
      return await readFile(absolute, 'utf8');
    } catch {
      return null;
    }
  }
}
