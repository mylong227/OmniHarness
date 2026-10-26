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
import { WorkspaceFileCoordinator } from './workspaceFileCoordinator.ts';

/**
 * 写文件工具：仅限工作区内，覆盖前自动备份 .bak（可审计）。
 *
 * ## 多会话并发语义（2026-10-25）
 *
 * 写路径经过 {@link WorkspaceFileCoordinator}：进程内写锁 + 跨进程租约 + 原子 rename。
 * 冲突判定分两层：
 *
 * 1. **有基线全文**：用 `base + ours + theirs` 做**行级三方合并**（共同祖先来自
 *    `SessionBaselineStore`）。双方改不同区域 ⇒ 自动合并并提示复核；同区域冲突 ⇒ 拒绝，
 *    绝不静默覆盖。
 * 2. **没有基线全文**（未读 / 文本超容量）：退回保守路径——本会话基线过期或等锁期间被别的
 *    会话改过 ⇒ 拒绝，让模型重读。没有基线的新文件仍按显式新建处理。
 *
 * 内容相同（逐字节）时**不写盘、不生成 .bak**，如实回报"无变化"——避免把空操作伪装成修改。
 */
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
   * @param context 工具上下文（其 workspaceRoot 优先——子智能体据此落到隔离工作树）。
   * @returns 执行结果：路径越界、等待锁失败、会话基线过期或等锁期间被并发修改时返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const content = String(call.arguments['content'] ?? '');
    const root = ToolWorkspaceRoot.of(this.workspaceRoot, context);
    const guard = new WorkspaceGuard(root);
    if (!guard.isInside(relative)) {
      return {
        callId: call.id,
        ok: false,
        // 报错做人话：给出当前可写根目录，模型据此改写为相对路径，避免反复试错触发 supervisor 降级。
        error:
          `路径越界: "${relative}" 不在工作区内。工作区根目录为 ${root}，` +
          `请改用相对此根目录的路径（例如 examples/plugins/demo-string/index.js）`,
      };
    }
    const absolute = resolve(root, relative);
    const coordinator = WorkspaceFileCoordinator.of(root);
    const ledger = this.ledger ?? coordinator.ledger;
    const owner = context.sessionId;
    try {
      const intent = await this.readIfExists(absolute);
      return await coordinator.withWrite(
        absolute,
        (lease) =>
          this.writeWithin(call, relative, absolute, content, intent, lease, ledger, owner),
        { ...(context.signal !== undefined ? { signal: context.signal } : {}) },
      );
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /**
   * 进入写锁之前判断「本会话读到的版本已经过期」。
   *
   * @param ledger 账本。
   * @param absolute 绝对路径。
   * @param relative 相对路径。
   * @param intent 操作开始时的磁盘内容（不存在为 undefined）。
   * @param owner 会话 id。
   * @returns 冲突文案；无冲突时 undefined。
   */
  private staleMessage(
    ledger: FileContentLedger,
    absolute: string,
    relative: string,
    intent: string | undefined,
    owner: string,
  ): string | undefined {
    const baseline = ledger.baselineOf(absolute, owner);
    if (baseline === undefined) return undefined;
    if (!ledger.changedSince(absolute, intent ?? '', owner)) return undefined;
    const detail = `你的基线 ${FileContentLedger.shortHash(baseline)}，当前 ${FileContentLedger.shortHash(
      FileContentLedger.hashOf(intent ?? ''),
    )}；${intent === undefined ? '文件已被外部删除' : '磁盘内容已变化'}`;
    return FileContentLedger.conflictMessage(relative, detail);
  }

  /**
   * 写锁内：复核并发状态 → 备份 → 原子写 → 记账。
   *
   * @param call 工具调用。
   * @param relative 相对路径。
   * @param absolute 绝对路径。
   * @param content 新内容。
   * @param intent 操作开始时读到的内容。
   * @param lease 写租约。
   * @param ledger 账本。
   * @param owner 会话 id。
   * @returns 工具结果。
   */
  private async writeWithin(
    call: ToolCall,
    relative: string,
    absolute: string,
    content: string,
    intent: string | undefined,
    lease: {
      read(): Promise<string | undefined>;
      backup(): Promise<void>;
      write(c: string): Promise<void>;
    },
    ledger: FileContentLedger,
    owner: string,
  ): Promise<ToolResult> {
    const current = await lease.read();
    if (current === content) {
      return {
        callId: call.id,
        ok: true,
        output: `无变化: ${relative} 内容与本会话读取到的现状逐字节相同，未写盘、未生成 .bak。`,
      };
    }
    const baselineText = ledger.baselineTextOf(absolute, owner);
    const baselineHash = ledger.baselineOf(absolute, owner);
    const baselineIsCurrent =
      baselineText !== undefined &&
      baselineHash !== undefined &&
      FileContentLedger.hashOf(baselineText) === baselineHash &&
      FileContentLedger.hashOf(current ?? '') === baselineHash;
    if (baselineIsCurrent && current !== undefined) {
      await lease.backup();
      await lease.write(content);
      ledger.remember(absolute, content, owner);
      return { callId: call.id, ok: true, output: `已写入 ${relative}` };
    }
    // 先尝试三方合并：base=该会话基线全文，ours=本次要写的内容，theirs=磁盘现状。
    // 双方改不同区域 ⇒ 可交换，保留对方改动；改同一区域 ⇒ 冲突，绝不猜。
    const merged = this.threeWay(ledger, absolute, relative, owner, content, current);
    if (merged !== undefined) {
      if (!merged.ok) return { callId: call.id, ok: false, error: merged.error };
      if (merged.content === current) {
        return {
          callId: call.id,
          ok: true,
          output: `无变化: ${relative} 磁盘现状已包含本次改动（其他会话无重叠修改），未写盘。`,
        };
      }
      await lease.backup();
      await lease.write(merged.content);
      ledger.remember(absolute, merged.content, owner);
      return {
        callId: call.id,
        ok: true,
        output:
          `已写入 ${relative}（自动三方合并：保留了其他会话的非重叠改动）` +
          (merged.content === content ? '' : '；合并后的内容与本次提交不同，请复核。'),
      };
    }
    // 没有可用的基线全文：退回保守路径（陈旧读/并发写都拒绝）。
    const stale = this.staleMessage(ledger, absolute, relative, current, owner);
    if (stale !== undefined) {
      return { callId: call.id, ok: false, error: stale };
    }
    if (current !== intent) {
      const detail = `操作开始后、拿到写锁前被其他会话/进程修改（${TextDiffSummary.of(intent ?? '', current ?? '')}）`;
      return {
        callId: call.id,
        ok: false,
        error:
          `未写入 ${relative}：${detail}。` +
          '为避免覆盖并发修改，本次写入已被拒绝；请 read_file 重读后重试。',
      };
    }
    await lease.backup();
    await lease.write(content);
    ledger.remember(absolute, content, owner);
    return { callId: call.id, ok: true, output: `已写入 ${relative}` };
  }

  /**
   * 尝试三方合并（只有在「该会话有基线全文且哈希与账本一致」时才可用）。
   *
   * @param ledger 账本。
   * @param absolute 绝对路径。
   * @param relative 相对路径（错误文案）。
   * @param owner 会话 id。
   * @param ours 本次要写的内容。
   * @param theirs 磁盘现状（undefined = 文件已不存在）。
   * @returns 合并结果；没有可用基线时 undefined（调用方走保守路径）。
   */
  private threeWay(
    ledger: FileContentLedger,
    absolute: string,
    relative: string,
    owner: string,
    ours: string,
    theirs: string | undefined,
  ):
    | { readonly ok: true; readonly content: string }
    | { readonly ok: false; readonly error: string }
    | undefined {
    if (theirs === undefined) return undefined;
    const baselineText = ledger.baselineTextOf(absolute, owner);
    const baselineHash = ledger.baselineOf(absolute, owner);
    if (
      baselineText === undefined ||
      baselineHash === undefined ||
      FileContentLedger.hashOf(baselineText) !== baselineHash
    ) {
      return undefined;
    }
    const result = TextThreeWayMerge.merge(baselineText, ours, theirs);
    if (result.ok) return { ok: true, content: result.content };
    if (result.reason === 'too-large') {
      return {
        ok: false,
        error:
          `未写入 ${relative}：文件过大，无法自动三方合并（请 read_file 重读后重试，` +
          '或把改动拆成 edit 的小段）。',
      };
    }
    return {
      ok: false,
      error: TextMergeConflictMessage.format(relative, '写入', result.conflicts),
    };
  }

  /**
   * 读取现有内容（用于备份与冲突检测）。
   *
   * 只把 ENOENT/ENOTDIR 当成「不存在」；EACCES/EISDIR 等真错误必须上抛，否则「读不到」会被
   * 伪装成「新建文件」并覆盖掉原文件。
   *
   * @param file 目标文件绝对路径。
   * @returns 文件内容；文件不存在时返回 `undefined`（区别于"存在但为空"）。
   */
  private async readIfExists(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      const code = WorkspaceFileCoordinator.codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  /** 提取错误消息（锁竞争文案已由协调器组织成人话）。
   * @param error 抛出的任意值。
   * @returns Error 取 message，其余转字符串。
   */
  private messageOf(error: unknown): string {
    if (error instanceof LockError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }
}
