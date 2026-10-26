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
import { LockError } from '../../../util/concurrency/lockError.ts';
import { FileContentLedger } from './fileContentLedger.ts';
import { StringReplaceEditor } from './stringReplaceEditor.ts';
import type { StringReplaceOutcome } from './stringReplaceEditor.ts';
import { WorkspaceFileCoordinator } from './workspaceFileCoordinator.ts';

/** 输出预览最多回显的行数（够模型确认改对了，又不至于把上下文撑大）。 */
const MAX_PREVIEW_LINES = 6;

/**
 * 内容替换编辑工具（`edit`）：**按内容**改工作区文件，不需要模型给出行号。
 *
 * 与既有两条写路径的分工：
 * - 新建/整文件重写 ⇒ `write_file`；
 * - 拿到现成 unified diff（且来自 `git diff` 这类可信来源）⇒ `apply_patch`；
 * - **改已有代码的常规路径 ⇒ 本工具**（`old_string` → `new_string`）。
 *
 * ## 并发语义：先三方合并，锚点只是无基线时的降级（2026-10-26）
 *
 * 两个会话同时改同一文件时，粗暴策略有两种，都不对：
 * - 「后写者一律拒绝」：明明改的是不同函数，却因为文件里别处变了而失败，模型只能重读重试；
 * - 「后写者一律放行」：若对方改的正是 `old_string` 所在片段，替换会落到错误位置或误删。
 *
 * 本工具有基线全文时，把「对 base 的替换」当作 ours，与磁盘现状做**行级 diff3**：
 * 区间不相交 ⇒ 合并；相交 ⇒ 拒绝。没有基线时才退回**内容锚点**判据（锚点仍唯一命中 ⇒
 * 替换到当前内容上；否则拒绝）。两种路径都不做猜测性改写。
 *
 * 安全与审计：仅限工作区内；覆盖前保留 `.bak`；匹配必须**唯一**，否则拒绝并提示补充上下文，
 * 绝不做猜测性改写（细节见 {@link StringReplaceEditor}）。
 */
export class EditFileTool {
  /** 替换内核（无状态）。 */
  private readonly editor = new StringReplaceEditor();

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.edit,
    description:
      '按内容精确替换工作区文件中的一段文本（推荐用于修改已有代码：无需给行号）。' +
      'old_string 必须在文件中唯一命中，否则请补充上下文或使用 replace_all。' +
      '容忍缩进与行尾空白差异。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的目标文件路径（文件须已存在）' },
        old_string: { type: 'string', description: '要被替换的原文本（须在文件中唯一）' },
        new_string: { type: 'string', description: '替换后的新文本（可为空串表示删除）' },
        replace_all: {
          type: 'boolean',
          description: 'true 时替换全部命中（默认 false，要求唯一命中）',
        },
        fuzzy: {
          type: 'boolean',
          description: '是否允许空白折叠的模糊匹配（默认 true；设 false 强制逐字符精确）',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  };

  /**
   * @param workspaceRoot 工作区根目录（编辑目标必须落在其内，越界即拒绝）。
   * @param ledger 内容账本（S1，可选）：写入前比对指纹，发现外部改动即拒绝改写。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly ledger?: FileContentLedger,
  ) {}

  /**
   * 执行内容替换。
   *
   * @param call 工具调用（实参含 path / old_string / new_string，可选 replace_all、fuzzy）。
   * @param context 工具上下文（其 workspaceRoot 优先——子智能体据此落到隔离工作树）。
   * @returns 成功时附替换处数与目标片段预览；路径越界 / 文件不存在 / 匹配歧义 / 并发冲突均失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const oldText = String(call.arguments['old_string'] ?? '');
    const newText = String(call.arguments['new_string'] ?? '');
    const root = ToolWorkspaceRoot.of(this.workspaceRoot, context);
    const guard = new WorkspaceGuard(root);
    if (!guard.isInside(relative)) {
      return {
        callId: call.id,
        ok: false,
        error:
          `路径越界: "${relative}" 不在工作区内。工作区根目录为 ${root}，` +
          '请改用相对此根目录的路径。',
      };
    }
    const absolute = resolve(root, relative);
    const coordinator = WorkspaceFileCoordinator.of(root);
    const ledger = this.ledger ?? coordinator.ledger;
    const owner = context.sessionId;
    try {
      const intent = await readFile(absolute, 'utf8');
      return await coordinator.withWrite(
        absolute,
        (lease) =>
          this.editWithin(call, relative, absolute, oldText, newText, intent, lease, ledger, owner),
        { ...(context.signal !== undefined ? { signal: context.signal } : {}) },
      );
    } catch (error) {
      return { callId: call.id, ok: false, error: this.readError(relative, error) };
    }
  }

  /**
   * 写锁内：优先用三方合并；没有基线全文时退回「在当前内容上按锚点替换」。
   *
   * @param call 工具调用。
   * @param relative 相对路径。
   * @param absolute 绝对路径。
   * @param oldText 原文本。
   * @param newText 新文本。
   * @param intent 操作开始时的内容。
   * @param lease 写租约。
   * @param ledger 账本。
   * @param owner 会话 id。
   * @returns 工具结果。
   */
  private async editWithin(
    call: ToolCall,
    relative: string,
    absolute: string,
    oldText: string,
    newText: string,
    intent: string,
    lease: {
      read(): Promise<string | undefined>;
      backup(): Promise<void>;
      write(content: string): Promise<void>;
    },
    ledger: FileContentLedger,
    owner: string,
  ): Promise<ToolResult> {
    const current = await lease.read();
    if (current === undefined) {
      return { callId: call.id, ok: false, error: `${relative} 已不存在（edit 只改已存在的文件）` };
    }
    const baseText = ledger.baselineTextOf(absolute, owner);
    const baseHash = ledger.baselineOf(absolute, owner);
    const baseValid =
      baseText !== undefined &&
      baseHash !== undefined &&
      FileContentLedger.hashOf(baseText) === baseHash;
    if (baseValid) {
      const result = await this.editWithBaseline(
        call,
        relative,
        absolute,
        oldText,
        newText,
        baseText,
        current,
        lease,
        ledger,
        owner,
      );
      if (result !== undefined) return result;
    }
    // 没有可用基线全文：退回「在当前内容上按锚点替换」的旧路径。
    const merged = current !== intent;
    const outcome = this.editor.replace(current, this.replaceOptions(call, oldText, newText));
    if (!outcome.ok) {
      const conflict = this.mergeConflict(relative, merged, intent, current, outcome);
      if (conflict !== undefined) return { callId: call.id, ok: false, error: conflict };
      return { callId: call.id, ok: false, error: `${relative}: ${outcome.error ?? '替换失败'}` };
    }
    const next = outcome.content ?? '';
    if (next === current) {
      return {
        callId: call.id,
        ok: true,
        output:
          `无变化: ${relative} 替换后内容与原文件逐字节相同（new_string 与 old_string 等价），未写盘。` +
          '若本意是修改，请检查 new_string 是否真的不同。',
      };
    }
    await lease.backup();
    await lease.write(next);
    ledger.remember(absolute, next, owner);
    return { callId: call.id, ok: true, output: this.report(relative, outcome, newText, merged) };
  }

  /**
   * 有基线全文时的三方合并：`base + ours(对 base 的替换) + theirs(磁盘现状)`。
   *
   * @param call 工具调用。
   * @param relative 相对路径。
   * @param absolute 绝对路径。
   * @param oldText 原文本。
   * @param newText 新文本。
   * @param baseText 基线全文。
   * @param current 磁盘现状。
   * @param lease 写租约。
   * @param ledger 账本。
   * @param owner 会话 id。
   * @returns 工具结果；无可用结果时 undefined（调用方退回锚点路径）。
   */
  private async editWithBaseline(
    call: ToolCall,
    relative: string,
    absolute: string,
    oldText: string,
    newText: string,
    baseText: string,
    current: string,
    lease: {
      backup(): Promise<void>;
      write(content: string): Promise<void>;
    },
    ledger: FileContentLedger,
    owner: string,
  ): Promise<ToolResult | undefined> {
    const baseOutcome = this.editor.replace(baseText, this.replaceOptions(call, oldText, newText));
    if (!baseOutcome.ok) {
      if (current !== baseText) {
        return {
          callId: call.id,
          ok: false,
          error:
            this.staleMessage(relative, absolute, current, ledger, owner) ??
            `${relative}: ${baseOutcome.error ?? '替换失败'}`,
        };
      }
      return {
        callId: call.id,
        ok: false,
        error: `${relative}: ${baseOutcome.error ?? '替换失败'}`,
      };
    }
    const ours = baseOutcome.content ?? '';
    const merged = TextThreeWayMerge.merge(baseText, ours, current);
    if (!merged.ok) {
      if (merged.reason === 'too-large') {
        if (current !== baseText) {
          return {
            callId: call.id,
            ok: false,
            error:
              this.staleMessage(relative, absolute, current, ledger, owner) ??
              `${relative}: 文件过大，无法自动三方合并`,
          };
        }
        return undefined;
      }
      return {
        callId: call.id,
        ok: false,
        error: this.conflictMessage(relative, merged.conflicts),
      };
    }
    if (merged.content === current) {
      return {
        callId: call.id,
        ok: true,
        output: `无变化: ${relative} 磁盘现状已包含本次替换（其他会话无重叠修改），未写盘。`,
      };
    }
    await lease.backup();
    await lease.write(merged.content);
    ledger.remember(absolute, merged.content, owner);
    return {
      callId: call.id,
      ok: true,
      output: this.report(relative, baseOutcome, newText, current !== baseText),
    };
  }

  /**
   * 组织替换选项。
   * @param call 工具调用。
   * @param oldText 原文本。
   * @param newText 新文本。
   * @returns 替换内核选项。
   */
  private replaceOptions(
    call: ToolCall,
    oldText: string,
    newText: string,
  ): {
    oldText: string;
    newText: string;
    replaceAll?: boolean;
    fuzzy?: boolean;
  } {
    return {
      oldText,
      newText,
      ...(call.arguments['replace_all'] === true ? { replaceAll: true } : {}),
      ...(call.arguments['fuzzy'] === false ? { fuzzy: false } : {}),
    };
  }

  /**
   * 组织三方合并冲突文案。
   * @param relative 相对路径。
   * @param conflicts 冲突区间。
   * @returns 可读错误。
   */
  private conflictMessage(
    relative: string,
    conflicts: readonly {
      readonly baseStart: number;
      readonly baseEnd: number;
      readonly ours: string;
      readonly theirs: string;
    }[],
  ): string {
    return TextMergeConflictMessage.format(relative, '改写', conflicts);
  }

  /**
   * 组织「基线已过期」文案。
   * @param relative 相对路径。
   * @param absolute 绝对路径。
   * @param current 磁盘现状。
   * @param ledger 账本。
   * @param owner 会话 id。
   * @returns 冲突文案；无基线时 undefined。
   */
  private staleMessage(
    relative: string,
    absolute: string,
    current: string,
    ledger: FileContentLedger,
    owner: string,
  ): string | undefined {
    const baseline = ledger.baselineOf(absolute, owner);
    if (baseline === undefined) return undefined;
    return FileContentLedger.conflictMessage(
      relative,
      `你的基线 ${FileContentLedger.shortHash(baseline)}，当前 ${FileContentLedger.shortHash(
        FileContentLedger.hashOf(current),
      )}`,
    );
  }

  /**
   * 当替换失败且文件在等锁期间被改过时，组织「冲突」而不是「普通替换失败」的文案。
   *
   * @param relative 相对路径。
   * @param merged 是否发生了等锁期间的并发修改。
   * @param before 操作开始时的内容。
   * @param current 当前内容。
   * @param outcome 替换结果（失败）。
   * @returns 冲突文案；不是并发冲突时 undefined。
   */
  private mergeConflict(
    relative: string,
    merged: boolean,
    before: string,
    current: string,
    outcome: StringReplaceOutcome,
  ): string | undefined {
    if (!merged) return undefined;
    return (
      `未改写 ${relative}：等待写锁期间被其他会话/进程修改（${TextDiffSummary.of(before, current)}），` +
      `且本次替换锚点已不再唯一命中（${outcome.error ?? '未找到 old_string'}）。` +
      '为避免改错位置，本次写入已被拒绝；请 read_file 重读后用最新内容重试。'
    );
  }

  /**
   * 组织成功回报（处数 / 行号 / 模糊提示 / 新片段预览 / 自动合并提示）。
   *
   * @param relative 目标文件相对路径。
   * @param outcome 替换结果（成功）。
   * @param newText 新文本（用于预览）。
   * @param merged 是否在等锁期间叠加了其他会话的改动。
   * @returns 可读回报文本。
   */
  private report(
    relative: string,
    outcome: StringReplaceOutcome,
    newText: string,
    merged: boolean,
  ): string {
    const count = outcome.replacements ?? 0;
    const kind =
      outcome.matchKind === undefined || outcome.matchKind === 'exact'
        ? ''
        : outcome.matchKind === 'whitespace'
          ? '［空白折叠匹配］'
          : '［行号前缀剥离匹配］';
    const mergeNote = merged ? '［自动合并：文件在等锁期间被其他会话改动，锚点未被触碰］\n' : '';
    const head =
      mergeNote +
      `${count === 1 ? '已替换 1 处' : `已批量替换 ${count} 处`}` +
      `（首次命中在第 ${outcome.line ?? 1} 行）: ${relative}${kind}`;
    const preview = EditFileTool.previewOf(newText);
    return preview === '' ? head : `${head}\n替换后片段：\n${preview}`;
  }

  /**
   * 把写入错误转成对模型可行动的人话（文件不存在时明确指向 `write_file`）。
   *
   * @param relative 目标文件相对路径。
   * @param error 抛出的任意值。
   * @returns 错误文案。
   */
  private readError(relative: string, error: unknown): string {
    if (error instanceof LockError) return error.message;
    const detail = error instanceof Error ? error.message : String(error);
    if (/ENOENT|no such file/i.test(detail)) {
      return `${relative} 不存在或不可读（edit 只改已存在的文件；新建请用 write_file）`;
    }
    return detail;
  }

  /**
   * 生成新文本的行预览（超过上限时附省略提示）。
   *
   * @param newText 替换后的文本。
   * @returns 预览文本；空串替换（删除）时返回空串。
   */
  private static previewOf(newText: string): string {
    if (newText === '') {
      return '（已删除该片段）';
    }
    const lines = newText.split('\n');
    const shown = lines.slice(0, MAX_PREVIEW_LINES);
    const suffix = lines.length > shown.length ? `\n… （共 ${lines.length} 行）` : '';
    return `${shown.join('\n')}${suffix}`;
  }
}
