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
import { PatchApplier } from './patchApplier.js';
import type { FilePatch } from './patchApplier.js';

/**
 * 应用补丁工具：unified diff 写入工作区文件。
 *
 * 语义（2026-09-19 重写后）：
 * - **多文件**：补丁里每个 `+++` 段都会被应用（此前只取首个头，其余被静默丢弃）；
 * - **原子**：先全部解析并全部试算，**任一段失败则一个字节都不写**；
 * - **容错**：行号写偏（±200 行内自动搜）、行尾空白差异、上下文里误带 `read_file` 行号前缀，
 *   都能正确落位（细节见 {@link PatchApplier}）；
 * - `path` 参数仅在**单文件补丁**时用于覆盖头里的目标路径（保持既有用法），多文件补丁以头为准。
 */
export class ApplyPatchTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.applyPatch,
    description:
      '应用 unified diff 补丁到工作区文件（支持多文件；任一段失败则整体不落盘）。' +
      '容错行号偏差、行尾空白与误带的行号前缀。',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'unified diff 内容（可含多个文件段）' },
        path: {
          type: 'string',
          description: '目标文件路径（可省略，缺省取 +++ 头；仅单文件补丁时生效）',
        },
      },
      required: ['patch'],
    },
  };

  /** 补丁解析/应用器（纯逻辑，失败不改动原文件）。 */
  private readonly applier = new PatchApplier();

  /**
   * @param workspaceRoot 工作区根目录（补丁目标必须落在其内，越界即拒绝）。
   * @param ledger 内容账本（S1，可选）：应用前逐目标比对指纹，发现外部改动即整体拒绝。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly ledger?: FileContentLedger,
  ) {}

  /**
   * 应用补丁。
   *
   * @param call 工具调用（实参含 patch，可选 path）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 执行结果：解析失败 / 路径越界 / 任一段应用失败都返回失败且不写任何文件；成功写入全部目标。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const patch = String(call.arguments['patch'] ?? '');
    const parsed = this.applier.parseFiles(patch);
    if (!parsed.ok) {
      return { callId: call.id, ok: false, error: parsed.error };
    }
    const targets = this.resolveTargets(call, parsed.files);
    if (targets === undefined) {
      return {
        callId: call.id,
        ok: false,
        error: 'patch 缺少目标文件（请提供 path 参数或 +++ 头）',
      };
    }
    const guard = new WorkspaceGuard(this.workspaceRoot);
    const originals = new Map<string, string>();
    for (const target of targets) {
      if (!guard.isInside(target)) {
        return { callId: call.id, ok: false, error: `路径越界: ${target}` };
      }
      const absolute = resolve(this.workspaceRoot, target);
      try {
        const original = await this.readExisting(absolute);
        // S1 冲突保护：账本有记录且已背离 ⇒ 拒绝整份补丁（原子语义：一个字节都不写）。
        if (this.ledger?.changedSince(absolute, original) === true) {
          return { callId: call.id, ok: false, error: FileContentLedger.conflictMessage(target) };
        }
        originals.set(target, original);
      } catch (error) {
        return { callId: call.id, ok: false, error: this.messageOf(error) };
      }
    }
    const result = this.applier.applyMany(originals, this.rewriteHeaders(patch, targets));
    if (!result.ok) {
      return { callId: call.id, ok: false, error: `补丁应用失败: ${result.error}` };
    }
    return this.writeAll(call.id, result.outputs, originals);
  }

  /**
   * 解析目标文件清单：`path` 仅在单文件补丁时覆盖（多文件补丁以各自 `+++` 头为准）。
   *
   * @param call 工具调用（实参可能含 path）。
   * @param files 补丁中的文件段。
   * @returns 目标相对路径列表；无法确定时为 undefined。
   */
  private resolveTargets(
    call: ToolCall,
    files: readonly FilePatch[],
  ): readonly string[] | undefined {
    const explicit = call.arguments['path'];
    if (typeof explicit === 'string' && explicit !== '' && files.length === 1) {
      return [explicit];
    }
    const targets = files.map((file) => file.targetFile).filter((target) => target !== '');
    return targets.length > 0 ? targets : undefined;
  }

  /**
   * 把单文件补丁头里的目标改写成显式 `path`（使 `path` 覆盖语义对应用器生效）。
   *
   * @param patch 原始补丁文本。
   * @param targets 生效的目标清单。
   * @returns 原补丁（无需改写或无法安全改写时）或已改写头的补丁。
   */
  private rewriteHeaders(patch: string, targets: readonly string[]): string {
    const only = targets[0];
    if (targets.length !== 1 || only === undefined) {
      return patch;
    }
    return patch
      .split('\n')
      .map((line) => (line.startsWith('+++ ') ? `+++ b/${only}` : line))
      .join('\n');
  }

  /**
   * 原子写入全部产出（先 `mkdir -p` 各自父目录，再逐个落盘），并**回报每个目标是否真的变了**。
   *
   * 为什么必须比对前后内容（编码能力，2026-09-26 缺口修复）：旧实现无条件回一句
   * `补丁已应用到 N 个文件`。但 `PatchApplier` 会在 ±200 行内模糊搜位，hunk 只含上下文行时
   * 写入结果与原文件**逐字节相同**——模型却收到「成功」。于是「改了个空操作」被当成「改好了」，
   * 后续自证与结论都建立在假事实上。现在把「变更 / 无变化」如实分开回报。
   *
   * @param callId 工具调用 ID。
   * @param outputs 各目标的新内容。
   * @param originals 各目标应用前的内容（新建文件为空串）。
   * @returns 成功结果（附变更清单）；写盘失败时返回失败。
   */
  private async writeAll(
    callId: string,
    outputs: readonly { readonly targetFile: string; readonly content: string }[],
    originals: ReadonlyMap<string, string>,
  ): Promise<ToolResult> {
    try {
      const changed: string[] = [];
      const unchanged: string[] = [];
      for (const output of outputs) {
        const absolute = resolve(this.workspaceRoot, output.targetFile);
        if ((originals.get(output.targetFile) ?? '') === output.content) {
          unchanged.push(output.targetFile);
          continue;
        }
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, output.content, 'utf8');
        this.ledger?.remember(absolute, output.content);
        changed.push(output.targetFile);
      }
      return { callId, ok: true, output: ApplyPatchTool.describe(changed, unchanged) };
    } catch (error) {
      return { callId, ok: false, error: this.messageOf(error) };
    }
  }

  /**
   * 组装变更回报文本（零变化时给出显式提示，避免模型把空操作读成成功修改）。
   *
   * @param changed 内容确实发生变化的相对路径。
   * @param unchanged 内容与原文件逐字节相同的相对路径。
   * @returns 面向模型的可读回报。
   */
  private static describe(changed: readonly string[], unchanged: readonly string[]): string {
    if (changed.length === 0) {
      return (
        `补丁已解析，但**未改变任何文件**（${unchanged.join(', ')}）：hunk 可能只含上下文行，` +
        '或改动已存在。请核对补丁内容后重发。'
      );
    }
    const head = `补丁已应用，变更 ${changed.length} 个文件: ${changed.join(', ')}`;
    return unchanged.length === 0
      ? head
      : `${head}；另有 ${unchanged.length} 个文件无变化（${unchanged.join(', ')}）`;
  }

  /** 读取已有文件（不存在视为空）。
   * @param file 目标文件绝对路径。
   * @returns 文件内容；读取失败/不存在返回空串（视为新建文件）。
   */
  private async readExisting(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return '';
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
