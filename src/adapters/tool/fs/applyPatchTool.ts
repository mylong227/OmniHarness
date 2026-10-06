import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';
import { ToolWorkspaceRoot } from '../../../util/toolWorkspaceRoot.js';
import { log } from '../../../util/logger.js';
import { FileContentLedger } from './fileContentLedger.js';
import { PatchApplier } from './patchApplier.js';
import type { FilePatch } from './patchApplier.js';

/**
 * 应用补丁工具：unified diff 写入工作区文件。
 *
 * 语义（2026-09-19 重写后 / 2026-10-03 补齐落盘失败面）：
 * - **多文件**：补丁里每个 `+++` 段都会被应用（此前只取首个头，其余被静默丢弃）；
 * - **原子**：先全部解析并全部试算，**任一段失败则一个字节都不写**；落盘阶段任一次写失败，
 *   已写成功的文件会被**回滚**到补丁前内容（新建文件则删除），使「整份补丁」要么全生效、
 *   要么全不生效——旧实现只保证解析期原子，写盘失败会留下**半份补丁**（第 2 个目标写失败时
 *   第 1 个已落盘且无回滚），与类文档承诺矛盾；
 * - **可审计**：覆盖已有文件前与 `write_file` / `edit` 一致地生成 `<file>.bak`；
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
   * @param context 工具上下文（其 workspaceRoot 优先——子智能体据此落到隔离工作树）。
   * @returns 执行结果：解析失败 / 路径越界 / 任一段应用失败都返回失败且不写任何文件；成功写入全部目标。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
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
    const root = ToolWorkspaceRoot.of(this.workspaceRoot, context);
    const guard = new WorkspaceGuard(root);
    const originals = new Map<string, string>();
    this.existing.clear();
    for (const target of targets) {
      if (!guard.isInside(target)) {
        return { callId: call.id, ok: false, error: `路径越界: ${target}` };
      }
      const absolute = resolve(root, target);
      try {
        const before = await this.readExisting(absolute, target);
        // S1 冲突保护：账本有记录且已背离 ⇒ 拒绝整份补丁（原子语义：一个字节都不写）。
        if (this.ledger?.changedSince(absolute, before.content) === true) {
          return { callId: call.id, ok: false, error: FileContentLedger.conflictMessage(target) };
        }
        originals.set(target, before.content);
        if (before.existed) {
          this.existing.add(target);
        }
      } catch (error) {
        return { callId: call.id, ok: false, error: this.messageOf(error) };
      }
    }
    const result = this.applier.applyMany(originals, this.rewriteHeaders(patch, targets));
    if (!result.ok) {
      return { callId: call.id, ok: false, error: `补丁应用失败: ${result.error}` };
    }
    return this.writeAll(call.id, result.outputs, originals, root);
  }

  /**
   * 本次调用中「补丁前已存在」的目标集合（决定回滚是还原还是删除）。
   *
   * 为什么必须区分：`readExisting` 对「不存在」与「存在但为空」都读回空串，
   * 二者在回滚时处置相反（删除 vs 写回空串）。用成员字段承载是因为 `handle` 已贴近体量基线，
   * 且每次 `handle` 调用都会先清空它。单实例并发调用同一工具不在设计内（工具端口按调用串行）。
   */
  private readonly existing = new Set<string>();

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
   * 原子写入全部产出（两阶段提交 + 失败回滚），并**回报每个目标是否真的变了**。
   *
   * 为什么必须比对前后内容（编码能力，2026-09-26 缺口修复）：旧实现无条件回一句
   * `补丁已应用到 N 个文件`。但 `PatchApplier` 会在 ±200 行内模糊搜位，hunk 只含上下文行时
   * 写入结果与原文件**逐字节相同**——模型却收到「成功」。于是「改了个空操作」被当成「改好了」，
   * 后续自证与结论都建立在假事实上。现在把「变更 / 无变化」如实分开回报。
   *
   * 为什么必须两阶段（2026-10-03 补 PROJECT_BOARD §3-6）：
   *  - **阶段 1（准备）**：建父目录 + 为已存在的目标写 `.bak`。此阶段失败时**一个字节都没写**，
   *    直接返回失败即可（与解析期原子一致）。
   *  - **阶段 2（提交）**：逐个落盘；任一次失败即**回滚**已写成功的文件（存在过的还原原文，
   *    新建的删除），并如实报告回滚件数。旧实现没有这一层：第 2 个目标写失败（磁盘满 /
   *    只读挂载 / EPERM）时第 1 个已落盘且无回滚——用户拿到「失败」，工作区却留下了半份补丁。
   *
   * @param callId 工具调用 ID。
   * @param outputs 各目标的新内容。
   * @param originals 各目标应用前的内容（不存在的目标为空串）。
   * @param root 本次调用解析出的工作区根（运行时 ctx 优先，见 `ToolWorkspaceRoot`）。
   * @returns 成功结果（附变更清单）；准备或提交失败时返回失败（提交失败时附回滚情况）。
   */
  private async writeAll(
    callId: string,
    outputs: readonly { readonly targetFile: string; readonly content: string }[],
    originals: ReadonlyMap<string, string>,
    root: string,
  ): Promise<ToolResult> {
    const pending = outputs.filter(
      (output) => (originals.get(output.targetFile) ?? '') !== output.content,
    );
    const unchanged = outputs
      .map((output) => output.targetFile)
      .filter((target) => !pending.some((output) => output.targetFile === target));
    try {
      await this.prepare(pending, originals, root);
    } catch (error) {
      return { callId, ok: false, error: `补丁未落盘（准备阶段失败）: ${this.messageOf(error)}` };
    }
    const written: string[] = [];
    for (const output of pending) {
      const absolute = resolve(root, output.targetFile);
      try {
        await writeFile(absolute, output.content, 'utf8');
        written.push(output.targetFile);
      } catch (error) {
        const rolled = await this.rollback(written, originals, root);
        return {
          callId,
          ok: false,
          error:
            `补丁落盘失败: ${this.messageOf(error)}` +
            `（已回滚 ${String(rolled)} 个文件，工作区保持补丁前状态）`,
        };
      }
    }
    for (const output of pending) {
      this.ledger?.remember(resolve(root, output.targetFile), output.content);
    }
    return {
      callId,
      ok: true,
      output: ApplyPatchTool.describe(
        pending.map((output) => output.targetFile),
        unchanged,
      ),
    };
  }

  /**
   * 提交前准备：建父目录，并为**已存在**的目标生成 `.bak`（与 `write_file` / `edit` 同口径）。
   * @param pending 内容确实会变化的目标（顺序即落盘顺序）。
   * @param originals 各目标应用前的内容。
   * @param root 本次调用解析出的工作区根。
   * @returns 准备完成后的 Promise；任一目标准备失败即抛出（调用方据此在**未写任何文件**时返回）。
   */
  private async prepare(
    pending: readonly { readonly targetFile: string; readonly content: string }[],
    originals: ReadonlyMap<string, string>,
    root: string,
  ): Promise<void> {
    for (const output of pending) {
      const absolute = resolve(root, output.targetFile);
      await mkdir(dirname(absolute), { recursive: true });
      if (this.existing.has(output.targetFile)) {
        await writeFile(`${absolute}.bak`, originals.get(output.targetFile) ?? '', 'utf8');
      }
    }
  }

  /**
   * 回滚已落盘的目标到补丁前状态（fail-soft：单件回滚失败只告警并计数，不掩盖原始写错误）。
   * @param written 已成功写入的相对路径（按落盘顺序）。
   * @param originals 各目标应用前的内容。
   * @param root 本次调用解析出的工作区根。
   * @returns 成功回滚的文件数。
   */
  private async rollback(
    written: readonly string[],
    originals: ReadonlyMap<string, string>,
    root: string,
  ): Promise<number> {
    let rolled = 0;
    for (const target of [...written].reverse()) {
      const absolute = resolve(root, target);
      try {
        if (this.existing.has(target)) {
          await writeFile(absolute, originals.get(target) ?? '', 'utf8');
        } else {
          await unlink(absolute);
        }
        this.ledger?.forget(absolute);
        rolled += 1;
      } catch (error) {
        log.warn('tool.apply_patch.rollback.failed', {
          target,
          error: this.messageOf(error),
        });
      }
    }
    return rolled;
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

  /**
   * 读取已有文件。
   *
   * `existed` 必须与内容分开返回：空文件与不存在的文件读回的都是空串，而回滚时二者处置相反
   * （写回空串 vs 删除）。**只把 ENOENT 视为「不存在」**——EACCES / EISDIR 等真错误必须上抛，
   * 否则「读不到」会被伪装成「新建文件」，接着把目标当新文件覆盖写掉。
   * @param file 目标文件绝对路径。
   * @param target 目标相对路径（错误标注用）。
   * @returns 文件内容与是否存在标记。
   * @throws 非 ENOENT 的读取错误（fail-closed，绝不当作「不存在」）。
   */
  private async readExisting(
    file: string,
    target: string,
  ): Promise<{ readonly content: string; readonly existed: boolean }> {
    try {
      return { content: await readFile(file, 'utf8'), existed: true };
    } catch (error) {
      if (ApplyPatchTool.isMissing(error)) {
        return { content: '', existed: false };
      }
      throw new Error(`读取 ${target} 失败: ${this.messageOf(error)}`);
    }
  }

  /** 判断读取错误是否为「文件不存在」。
   * @param error 抛出的任意值。
   * @returns 错误码为 ENOENT 时为 true。
   */
  private static isMissing(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
    );
  }

  /** 提取错误消息。
   * @param error 抛出的任意值。
   * @returns Error 取 message，其余转字符串。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
