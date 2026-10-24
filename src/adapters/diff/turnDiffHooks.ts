import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolResult } from '../../ports/tool/tool.ts';
import type { ToolHookContext, ToolHooks } from '../../ports/tool/toolHook.ts';
import type { TurnDiffTrackerPort } from '../../ports/runtime/turnDiffTracker.ts';
import { TOOL_NAMES } from '../../ports/tool/toolNames.ts';

/** 参与变更追踪的写类工具：参数带 `path`，可精确定位目标文件。 */
export const TRACKED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAMES.writeFile,
  TOOL_NAMES.edit,
  TOOL_NAMES.applyPatch,
]);

/** shell 命令对工作区的影响分类（变更追踪用）。 */
type ShellEffect =
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'mutate' }
  | { readonly kind: 'readonly' };

/**
 * 变更追踪钩子（#M5，回合内写类工具的前后快照）。
 *
 * 写类工具执行前读一次 baseline、执行后取一次快照，喂给 `TurnDiffTracker`，
 * 使回合结束时能产出完整 unified diff，而无需重扫整个工作区。
 *
 * **基线只在 tracker 里存一份**（2026-10-03 修，PROJECT_BOARD §3-2）：旧实现让本类自持一张
 * `Map<path, before>`，而回合结束时 `TurnRunner` 只调 `tracker.reset()`——那张表**从不清理**
 * 且**只增不减**。后果两层：
 *  ① 回合 2 再写同一文件时，`baseline.has(path)` 命中回合 1 的记录 ⇒ diff 的 before 侧是
 *     回合 1 之前的内容，`turn_diff` 事件呈现**跨回合累计差异**；
 *  ② 长会话里那张表按被触碰过的文件数单调增长。
 * 现在钩子只负责「本回合是否已为该路径读过盘」（`tracker.hasBaseline`），其余交给 tracker：
 * 它随 `reset()` 一起清空，跨回合复用**在结构上不可能**发生。
 *
 * **shell 边界（2026-10-20）**：只精确追踪**单目标、无通配符**的 `del` / `erase` / `rm`
 *（删除会渲染成全量删除行）；其余可能改动工作区的 shell 命令（copy/move/重定向/脚本执行/
 * 依赖安装…）一律让本回合 diff 失效。宁可没有 diff，也不给一份漏掉删除/移动的差异。
 */
export class TurnDiffHooks {
  public constructor(
    /** 变更追踪端口：基线/写入结果经它记入回合 diff（**基线的唯一事实源**）。 */
    private readonly tracker: TurnDiffTrackerPort,
    /** 工作区根目录（相对路径拼接基准）。 */
    private readonly workspaceRoot: string,
  ) {}

  /** 产出可注册进 `ToolHookRunner` 的钩子组。
   * @returns pre/post 钩子对：pre 抓基线，post 抓写后内容并喂给 tracker。
   */
  public hooks(): ToolHooks {
    return {
      pre: (context) => this.captureBaseline(context),
      post: (context, result) => this.captureResult(context, result),
    };
  }

  /** 执行前：本回合首次触碰某文件时读一次原始内容并登记为基线（后续同回合再写不覆盖）。
   * @param context 工具钩子上下文（工具名与参数，用于定位目标文件）。
   
   * @returns 无返回值。
   */
  private async captureBaseline(context: ToolHookContext): Promise<void> {
    if (context.toolName === TOOL_NAMES.shell) {
      const effect = TurnDiffHooks.classifyShell(String(context.args?.['command'] ?? ''));
      if (effect.kind === 'delete') {
        const absolute = this.absoluteOf(effect.path);
        try {
          // 目录删除无法用单文件 diff 表达 ⇒ 宁可让本回合 diff 失效，也不给不完整差异。
          if (statSync(absolute).isDirectory()) {
            this.tracker.invalidate();
            return;
          }
        } catch {
          // 目标不存在：删除是 no-op；基线记 null，post 侧若仍不存在则无实质 diff。
          this.tracker.recordBaseline(effect.path, null);
          return;
        }
        this.tracker.recordBaseline(effect.path, await this.readText(absolute));
      }
      return;
    }
    const path = this.pathOf(context);
    if (path === undefined || this.tracker.hasBaseline(path)) {
      return;
    }
    this.tracker.recordBaseline(path, await this.readText(this.absoluteOf(path)));
  }

  /** 执行后：成功才记录；读不到新内容一律 invalidate（不给不完整的差异）。
   * @param context 工具钩子上下文（工具名与参数）。
   * @param result 工具执行结果（仅 ok 时记账）。
   
   * @returns 无返回值。
   */
  private async captureResult(context: ToolHookContext, result: ToolResult): Promise<void> {
    if (context.toolName === TOOL_NAMES.shell) {
      if (!result.ok) {
        return;
      }
      const effect = TurnDiffHooks.classifyShell(String(context.args?.['command'] ?? ''));
      if (effect.kind === 'mutate') {
        // 无法精确追踪的 shell 变更（copy/move/重定向/脚本执行…）：整个回合 diff 失效。
        this.tracker.invalidate();
        return;
      }
      if (effect.kind === 'delete') {
        const after = await this.readText(this.absoluteOf(effect.path));
        if (after === null) {
          // 文件确实不在了 ⇒ 以「写空内容」表达删除，diff 会渲染成全量删除行。
          this.tracker.noteWrite(effect.path, '');
        } else {
          this.tracker.invalidate();
        }
      }
      return;
    }
    const path = this.pathOf(context);
    if (path === undefined || !result.ok) {
      return;
    }
    const after = await this.afterOf(context, path);
    if (after === null) {
      this.tracker.invalidate();
      return;
    }
    this.tracker.noteWrite(path, after);
  }

  /**
   * 把 shell 命令分类成「单文件删除 / 不可追踪变更 / 只读」。
   *
   * 只识别**单目标、无通配符**的 `del` / `erase` / `rm`：这是模型清理临时文件时最常见的形态
   *（2026-10-19 鹈鹕会话的 `del _preview_server.js` 就是它）。多目标、通配符、目录删除一律
   * 归为 `mutate`，由调用方让整个回合 diff 失效——**宁可不给，也不给一份少了删除的差异**。
   *
   * @param command 原始 shell 命令。
   * @returns 影响分类。
   */
  public static classifyShell(command: string): ShellEffect {
    const text = command.trim();
    if (text === '') {
      return { kind: 'readonly' };
    }
    const simpleDelete = /^(?:del|erase|rm)\s+(.+)$/is.exec(text);
    if (simpleDelete !== null) {
      const tokens = (simpleDelete[1] ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      const targets = tokens
        .map((token) => token.replace(/^["']|["']$/gu, ''))
        .filter(
          (token) => !token.startsWith('/') && !token.startsWith('-') && !/[?*]/u.test(token),
        );
      if (targets.length === 1) {
        return { kind: 'delete', path: targets[0] as string };
      }
      return { kind: 'mutate' };
    }
    const mutating =
      /(^|[&|]\s*)(?:del|erase|rm|rmdir|rd|move|mv|ren|rename|copy|cp|xcopy|robocopy|mkdir|md|touch|tee)\b/iu.test(
        text,
      ) ||
      /(^|[^>])>>?[^>]/u.test(text) ||
      /\bgit\s+(?:checkout|reset|clean|apply|stash|merge|rebase)\b/iu.test(text) ||
      /\b(?:npm|pnpm|yarn)\s+(?:install|ci|add|remove|update)\b/iu.test(text) ||
      /\b(?:pip|pip3)\s+install\b/iu.test(text) ||
      /\bnode\s+(?!-)/iu.test(text) ||
      /\b(?:python|py)\s+(?!-)/iu.test(text);
    return mutating ? { kind: 'mutate' } : { kind: 'readonly' };
  }

  /** 取执行后内容：write_file 直接用入参（省一次 IO），apply_patch 读回磁盘。
   * @param context 工具钩子上下文（write_file 时从 args.content 取新内容）。
   * @param path 目标文件相对路径（apply_patch 时读该文件）。
   * @returns 写后文本；读不到时为 null（调用方据此 invalidate 整个回合差异）。
   */
  private async afterOf(context: ToolHookContext, path: string): Promise<string | null> {
    if (context.toolName === TOOL_NAMES.writeFile) {
      return String(context.args !== undefined ? (context.args['content'] ?? '') : '');
    }
    return this.readText(this.absoluteOf(path));
  }

  /** 提取目标路径（仅追踪参数显式带 path 的写类工具）。
   * @param context 工具钩子上下文。
   * @returns 参数中的 path 字符串；工具不在追踪集、无参数或 path 非法时为 undefined（不追踪）。
   */
  private pathOf(context: ToolHookContext): string | undefined {
    if (!TRACKED_WRITE_TOOLS.has(context.toolName)) {
      return undefined;
    }
    const raw = context.args !== undefined ? context.args['path'] : undefined;
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  }

  /** 相对路径转绝对（工具侧已由 WorkspaceGuard 限界，此处只做拼接）。
   * @param relative 相对工作区根的路径。
   * @returns 以 workspaceRoot 为基准解析出的绝对路径。
   */
  private absoluteOf(relative: string): string {
    return resolve(this.workspaceRoot, relative);
  }

  /** 读文本；文件不存在或不可读返回 null。
   * @param absolute 文件绝对路径。
   * @returns UTF-8 文本内容；任何读取失败都归一为 null（不抛错）。
   */
  private async readText(absolute: string): Promise<string | null> {
    try {
      return await readFile(absolute, 'utf8');
    } catch {
      return null;
    }
  }
}
