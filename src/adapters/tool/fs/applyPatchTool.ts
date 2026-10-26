import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import { WorkspaceGuard } from '../../../util/workspaceGuard.ts';
import { ToolWorkspaceRoot } from '../../../util/toolWorkspaceRoot.ts';
import { TextDiffSummary } from '../../../util/textDiffSummary.ts';
import { TextThreeWayMerge } from '../../../util/textThreeWayMerge.ts';
import { TextMergeConflictMessage } from '../../../util/textMergeConflictMessage.ts';
import { log } from '../../../util/logger.ts';
import { FileContentLedger } from './fileContentLedger.ts';
import { PatchApplier } from './patchApplier.ts';
import type { FilePatch } from './patchApplier.ts';
import { WorkspaceFileCoordinator, type FileWriteLease } from './workspaceFileCoordinator.ts';

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
 * - **并发合并**：有会话基线全文时，先把补丁应用到 base 得到 ours，再与磁盘现状做行级
 *   diff3；双方改不同区域 ⇒ 合并，同区域冲突 ⇒ 整份补丁不落盘（细节见 `mergeWithBaselines`）；
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
   * 解析失败时附带的**最小可用格式**。
   *
   * 为什么错误里要带示例：模型常凭记忆写 patch，最常见的两种错法是 ①`*** Begin Patch` 这类
   * 自定义头（本工具只认 unified diff）②`@@` 后不写行号区间。只回「缺少 +++ 头 / 缺少有效
   * hunk」时，模型会**再猜一次**（2026-10-19 鹈鹕会话实测：两次失败后才改用带行号的写法）。
   * 给一段 6 行示例，比任何形容词都省一轮调用。
   */
  private static readonly FORMAT_HINT =
    '需要标准 unified diff（必须带 `+++` 文件头与 `@@ -旧起点,旧行数 +新起点,新行数 @@`）。示例：\n' +
    '--- a/file.txt\n' +
    '+++ b/file.txt\n' +
    '@@ -1,2 +1,2 @@\n' +
    '-旧的一行\n' +
    '+新的一行\n' +
    ' 未改动的上下文行';

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
      return {
        callId: call.id,
        ok: false,
        error: `${parsed.error}\n${ApplyPatchTool.FORMAT_HINT}`,
      };
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
    const coordinator = WorkspaceFileCoordinator.of(root);
    const ledger = this.ledger ?? coordinator.ledger;
    const originals = new Map<string, string>();
    const existing = new Set<string>();
    const absolutes: string[] = [];
    for (const target of targets) {
      if (!guard.isInside(target)) {
        return { callId: call.id, ok: false, error: `路径越界: ${target}` };
      }
      const absolute = resolve(root, target);
      try {
        const before = await this.readExisting(absolute, target);
        originals.set(target, before.content);
        absolutes.push(absolute);
        if (before.existed) existing.add(target);
      } catch (error) {
        return { callId: call.id, ok: false, error: this.messageOf(error) };
      }
    }
    try {
      return await coordinator.withWriteMany(
        absolutes,
        (leases) =>
          this.applyWithin(
            call,
            patch,
            targets,
            originals,
            existing,
            leases,
            ledger,
            context.sessionId,
            root,
          ),
        { ...(context.signal !== undefined ? { signal: context.signal } : {}) },
      );
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /**
   * 在全部目标锁内：重读现状 → 应用补丁 → 两阶段落盘。
   *
   * @param call 工具调用。
   * @param files 补丁文件段。
   * @param targets 生效目标清单。
   * @param originals 操作开始时的内容。
   * @param existing 操作开始时已存在的目标集合。
   * @param leases 目标绝对路径 → 写租约。
   * @param ledger 账本。
   * @param owner 会话 id。
   * @param root 工作区根。
   * @returns 工具结果。
   */
  private async applyWithin(
    call: ToolCall,
    patch: string,
    targets: readonly string[],
    originals: ReadonlyMap<string, string>,
    existing: ReadonlySet<string>,
    leases: ReadonlyMap<string, FileWriteLease>,
    ledger: FileContentLedger,
    owner: string,
    root: string,
  ): Promise<ToolResult> {
    const currents = new Map<string, string>();
    for (const target of targets) {
      const lease = leases.get(resolve(root, target));
      currents.set(target, (await lease?.read()) ?? '');
    }
    const merged = targets.some((target) => currents.get(target) !== originals.get(target));
    const threeWay = this.mergeWithBaselines(
      patch,
      targets,
      originals,
      currents,
      ledger,
      owner,
      root,
    );
    if (threeWay !== undefined) {
      if (!threeWay.ok) return { callId: call.id, ok: false, error: threeWay.error };
      return this.writeAll(
        call.id,
        threeWay.outputs,
        currents,
        originals,
        existing,
        leases,
        ledger,
        owner,
        root,
        merged || threeWay.merged,
      );
    }
    const result = this.applier.applyMany(currents, this.rewriteHeaders(patch, targets));
    if (!result.ok) {
      if (merged) {
        const changed = targets.filter((target) => currents.get(target) !== originals.get(target));
        const detail = changed
          .map(
            (target) =>
              `${target}：${TextDiffSummary.of(originals.get(target) ?? '', currents.get(target) ?? '')}`,
          )
          .join('；');
        return {
          callId: call.id,
          ok: false,
          error:
            `补丁未应用：等待写锁期间目标被其他会话/进程修改（${detail}），且补丁已无法在当前内容上应用。` +
            '为避免改错位置，本次一个字节都未写入；请 read_file 重读后重发补丁。',
        };
      }
      return { callId: call.id, ok: false, error: `补丁应用失败: ${result.error}` };
    }
    return this.writeAll(
      call.id,
      result.outputs,
      currents,
      originals,
      existing,
      leases,
      ledger,
      owner,
      root,
      merged,
    );
  }

  /**
   * 尝试用会话基线做三方合并：`base + ours(补丁应用到 base) + theirs(磁盘现状)`。
   *
   * @param patch 补丁文本。
   * @param targets 目标清单。
   * @param originals 操作开始时内容。
   * @param currents 拿到锁后的内容。
   * @param ledger 账本。
   * @param owner 会话 id。
   * @param root 工作区根。
   * @returns 合并产出；没有可用基线时 undefined（调用方走「在 current 上重放」的旧路径）。
   */
  private mergeWithBaselines(
    patch: string,
    targets: readonly string[],
    originals: ReadonlyMap<string, string>,
    currents: ReadonlyMap<string, string>,
    ledger: FileContentLedger,
    owner: string,
    root: string,
  ):
    | {
        readonly ok: true;
        readonly outputs: readonly { readonly targetFile: string; readonly content: string }[];
        readonly merged: boolean;
      }
    | { readonly ok: false; readonly error: string }
    | undefined {
    const baselines = new Map<string, string>();
    for (const target of targets) {
      const absolute = resolve(root, target);
      const text = ledger.baselineTextOf(absolute, owner);
      const hash = ledger.baselineOf(absolute, owner);
      if (text !== undefined && hash !== undefined && FileContentLedger.hashOf(text) === hash) {
        baselines.set(target, text);
      } else if (currents.get(target) !== originals.get(target)) {
        // 该目标在等锁期间变了，却没有基线全文 ⇒ 无法安全合并，退回旧路径（会拒绝）。
        return undefined;
      }
    }
    if (baselines.size === 0) return undefined;
    const baseMap = new Map<string, string>();
    for (const target of targets) {
      baseMap.set(target, baselines.get(target) ?? currents.get(target) ?? '');
    }
    const baseResult = this.applier.applyMany(baseMap, this.rewriteHeaders(patch, targets));
    if (!baseResult.ok) {
      for (const [target, base] of baselines) {
        if (currents.get(target) === base) continue;
        return {
          ok: false,
          error:
            this.staleMessage(
              ledger,
              resolve(root, target),
              target,
              currents.get(target) ?? '',
              owner,
            ) ?? `补丁无法应用到会话基线: ${baseResult.error}`,
        };
      }
      return undefined;
    }
    const outputs: { readonly targetFile: string; readonly content: string }[] = [];
    let merged = false;
    for (const output of baseResult.outputs) {
      const current = currents.get(output.targetFile) ?? '';
      if (current === output.content) {
        outputs.push(output);
        continue;
      }
      const base = baselines.get(output.targetFile);
      if (base === undefined) return undefined;
      const result = TextThreeWayMerge.merge(base, output.content, current);
      if (!result.ok) {
        if (result.reason === 'too-large') return undefined;
        return {
          ok: false,
          error: TextMergeConflictMessage.format(output.targetFile, '应用补丁', result.conflicts),
        };
      }
      outputs.push({ targetFile: output.targetFile, content: result.content });
      if (result.content !== output.content) merged = true;
    }
    return { ok: true, outputs, merged };
  }

  /**
   * 进入锁前判断本会话基线是否过期。
   *
   * @param ledger 账本。
   * @param absolute 绝对路径。
   * @param target 相对路径。
   * @param content 操作开始时的内容。
   * @param owner 会话 id。
   * @returns 冲突文案；无冲突时 undefined。
   */
  private staleMessage(
    ledger: FileContentLedger,
    absolute: string,
    target: string,
    content: string,
    owner: string,
  ): string | undefined {
    const baseline = ledger.baselineOf(absolute, owner);
    if (baseline === undefined || !ledger.changedSince(absolute, content, owner)) return undefined;
    const detail = `你的基线 ${FileContentLedger.shortHash(baseline)}，当前 ${FileContentLedger.shortHash(
      FileContentLedger.hashOf(content),
    )}`;
    return FileContentLedger.conflictMessage(target, detail);
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
   * 原子写入全部产出（两阶段提交 + 失败回滚），并**回报每个目标是否真的变了**。
   *
   * 为什么必须比对前后内容（编码能力，2026-09-26 缺口修复）：旧实现无条件回一句
   * `补丁已应用到 N 个文件`。但 `PatchApplier` 会在 ±200 行内模糊搜位，hunk 只含上下文行时
   * 写入结果与原文件**逐字节相同**——模型却收到「成功」。于是「改了个空操作」被当成「改好了」，
   * 后续自证与结论都建立在假事实上。现在把「变更 / 无变化」如实分开回报。
   *
   * 为什么必须两阶段（2026-10-03 补 PROJECT_BOARD §3-6）：
   *  - **阶段 1（准备）**：为已存在的目标写 `.bak`。此阶段失败时**一个字节都没写**，
   *    直接返回失败即可（与解析期原子一致）。
   *  - **阶段 2（提交）**：逐个落盘；任一次失败即**回滚**已写成功的文件（存在过的还原原文，
   *    新建的删除），并如实报告回滚件数。
   *
   * 并发：本方法只在 `withWriteMany` 持有**全部目标锁**时调用，故准备/提交/回滚不会与其他
   * 会话交错；回滚也走同一租约（原子写），不会留下半截文件。
   *
   * @param callId 工具调用 ID。
   * @param outputs 各目标的新内容。
   * @param currents 各目标拿到写锁后的内容（不存在的目标为空串）。
   * @param originals 各目标操作开始时的内容（用于判断「无变化」）。
   * @param existing 操作开始时已存在的目标集合（决定回滚是还原还是删除）。
   * @param leases 绝对路径 → 写租约。
   * @param ledger 账本。
   * @param owner 会话 id。
   * @param root 工作区根。
   * @param merged 等锁期间是否叠加了其他会话的改动（回报用）。
   * @returns 成功结果（附变更清单）；准备或提交失败时返回失败（提交失败时附回滚情况）。
   */
  private async writeAll(
    callId: string,
    outputs: readonly { readonly targetFile: string; readonly content: string }[],
    currents: ReadonlyMap<string, string>,
    originals: ReadonlyMap<string, string>,
    existing: ReadonlySet<string>,
    leases: ReadonlyMap<string, FileWriteLease>,
    ledger: FileContentLedger,
    owner: string,
    root: string,
    merged: boolean,
  ): Promise<ToolResult> {
    const pending = outputs.filter(
      (output) => (currents.get(output.targetFile) ?? '') !== output.content,
    );
    const unchanged = outputs
      .map((output) => output.targetFile)
      .filter((target) => !pending.some((output) => output.targetFile === target));
    try {
      await this.prepare(pending, existing, leases, root);
    } catch (error) {
      return { callId, ok: false, error: `补丁未落盘（准备阶段失败）: ${this.messageOf(error)}` };
    }
    const written: string[] = [];
    for (const output of pending) {
      const lease = leases.get(resolve(root, output.targetFile));
      if (lease === undefined) {
        return { callId, ok: false, error: `补丁目标未持锁: ${output.targetFile}` };
      }
      try {
        await lease.write(output.content);
        written.push(output.targetFile);
      } catch (error) {
        const rolled = await this.rollback(
          written,
          originals,
          existing,
          leases,
          ledger,
          owner,
          root,
        );
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
      ledger.remember(resolve(root, output.targetFile), output.content, owner);
    }
    return {
      callId,
      ok: true,
      output:
        ApplyPatchTool.describe(
          pending.map((output) => output.targetFile),
          unchanged,
        ) + (merged ? '\n［自动合并：目标在等锁期间被其他会话改动，补丁已应用到最新内容］' : ''),
    };
  }

  /**
   * 提交前准备：为**已存在**的目标生成 `.bak`（与 `write_file` / `edit` 同口径）。
   * @param pending 内容确实会变化的目标（顺序即落盘顺序）。
   * @param existing 操作开始时已存在的目标集合。
   * @param leases 绝对路径 → 写租约。
   * @param root 本次调用解析出的工作区根。
   * @returns 准备完成后的 Promise；任一目标准备失败即抛出（调用方据此在**未写任何文件**时返回）。
   */
  private async prepare(
    pending: readonly { readonly targetFile: string; readonly content: string }[],
    existing: ReadonlySet<string>,
    leases: ReadonlyMap<string, FileWriteLease>,
    root: string,
  ): Promise<void> {
    for (const output of pending) {
      if (!existing.has(output.targetFile)) continue;
      const lease = leases.get(resolve(root, output.targetFile));
      if (lease === undefined) throw new Error(`补丁目标未持锁: ${output.targetFile}`);
      await lease.backup();
    }
  }

  /**
   * 回滚已落盘的目标到补丁前状态（fail-soft：单件回滚失败只告警并计数，不掩盖原始写错误）。
   * @param written 已成功写入的相对路径（按落盘顺序）。
   * @param originals 各目标操作开始时的内容。
   * @param existing 操作开始时已存在的目标集合。
   * @param leases 绝对路径 → 写租约。
   * @param ledger 账本。
   * @param root 本次调用解析出的工作区根。
   * @returns 成功回滚的文件数。
   */
  private async rollback(
    written: readonly string[],
    originals: ReadonlyMap<string, string>,
    existing: ReadonlySet<string>,
    leases: ReadonlyMap<string, FileWriteLease>,
    ledger: FileContentLedger,
    owner: string,
    root: string,
  ): Promise<number> {
    let rolled = 0;
    for (const target of [...written].reverse()) {
      const absolute = resolve(root, target);
      const lease = leases.get(absolute);
      try {
        if (lease === undefined) throw new Error(`补丁目标未持锁: ${target}`);
        if (existing.has(target)) {
          await lease.write(originals.get(target) ?? '');
        } else {
          await lease.remove();
        }
        // 回滚后磁盘回到补丁前：账本必须跟着退回，否则下一次写入会拿「补丁后版本」误判。
        if (existing.has(target)) {
          ledger.remember(absolute, originals.get(target) ?? '', owner);
        } else {
          ledger.forget(absolute);
        }
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
