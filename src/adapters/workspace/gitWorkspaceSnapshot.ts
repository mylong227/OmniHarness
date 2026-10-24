import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  FileSnapshot,
  FileSnapshotEntry,
  WorkspaceSnapshotPort,
} from '../../ports/tool/workspaceSnapshot.ts';

/**
 * 基于 git 工作树差异的工作区快照适配器。
 *
 * 捕获策略（fail-closed：git 不可用或非仓库时抛错，绝不静默跳过文件回滚）：
 *   - 用 `git status --porcelain` 取会话触碰的文件集合；
 *   - 对每个被 HEAD 跟踪的文件，`git show HEAD:<path>` 取其「回滚目标」内容；
 *   - 未跟踪（??）或从未提交的新增文件 → content=null（回滚时删除）。
 *
 * 还原策略：仅对快照内文件手术式操作（覆盖/删除），不重置整棵树，不执行 `git checkout -- .`。
 *
 * ## 2026-10-23 硬化（数据完整性 + 内存）
 *
 * - **二进制不再按 UTF-8 往返**：PNG/PDF/压缩包等非 UTF-8 字节用 base64 原样保存，
 *   否则 `toString('utf8')` 会把非法字节替换成 U+FFFD，回滚即损坏文件。
 * - **单文件/单快照上限**：超过 {@link GitWorkspaceSnapshot.DEFAULT_MAX_FILE_BYTES} 的文件
 *   或超过总预算的文件标记 `skipped`，restore 时保留现场（不删除、不写半截）。
 * - 上限是**保护**，不是静默截断：`skipped/skipReason` 会进入快照，调用方可如实展示。
 */

/** 快照上限选项。 */
export interface GitWorkspaceSnapshotOptions {
  /** 单文件字节上限（缺省 2 MiB）。 */
  readonly maxFileBytes?: number;
  /** 单次快照总字节上限（缺省 32 MiB）。 */
  readonly maxTotalBytes?: number;
}

/** 捕获预算（跨文件累计）。 */
interface CaptureBudget {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  usedBytes: number;
}

/** 一次捕获的上下文（根、预算）。 */
interface CaptureContext {
  readonly root: string;
  readonly budget: CaptureBudget;
}

/** Git 工作区快照适配器：实现 WorkspaceSnapshotPort，适合 git 仓库内的工作树（按 HEAD 差异捕获/还原）。 */
export class GitWorkspaceSnapshot implements WorkspaceSnapshotPort {
  /** 适配器名，与端口契约一致：固定为 'git'。 */
  public readonly name = 'git';

  /** 单文件默认上限：2 MiB（超过即 skipped，不进入 JSON/内存）。 */
  public static readonly DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

  /** 单次快照默认总预算：32 MiB。 */
  public static readonly DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

  /** 生效单文件上限（构造时归一化，非正/非有限回落默认）。 */
  private readonly maxFileBytes: number;
  /** 生效单快照总预算（构造时归一化，非正/非有限回落默认）。 */
  private readonly maxTotalBytes: number;

  /**
   * @param options 单文件/总量上限（缺省 2 MiB / 32 MiB）。
   */
  public constructor(options: GitWorkspaceSnapshotOptions = {}) {
    this.maxFileBytes = GitWorkspaceSnapshot.positiveOr(
      options.maxFileBytes,
      GitWorkspaceSnapshot.DEFAULT_MAX_FILE_BYTES,
    );
    this.maxTotalBytes = GitWorkspaceSnapshot.positiveOr(
      options.maxTotalBytes,
      GitWorkspaceSnapshot.DEFAULT_MAX_TOTAL_BYTES,
    );
  }

  /** 捕获会话触碰文件相对 HEAD 的差异。
   * @param root 工作树根目录（须为 git 仓库，否则抛错）。
   * @returns 含根绝对路径与逐文件条目的快照（content 为回滚目标内容，null 表示回滚时删除）。
   */
  public async capture(root: string): Promise<FileSnapshot> {
    // 校验为 git 仓库（非仓库则下面的命令会抛错，fail-closed）。
    await GitWorkspaceSnapshot.git(['rev-parse', '--is-inside-work-tree'], root);
    const porcelain = await GitWorkspaceSnapshot.git(['status', '--porcelain', '-z'], root);
    const context: CaptureContext = {
      root,
      budget: {
        maxFileBytes: this.maxFileBytes,
        maxTotalBytes: this.maxTotalBytes,
        usedBytes: 0,
      },
    };
    const entries = await this.parsePorcelain(porcelain, context);
    return { root: resolve(root), entries };
  }

  /** 解析 `git status --porcelain -z` 输出为文件快照条目。
   * @param porcelain git status 的 NUL 分隔输出（含删除/修改/新增/重命名各状态行）。
   * @param context 捕获上下文（根 + 预算）。
   * @returns 快照条目列表：删除项取 HEAD 内容，其余取快照时刻磁盘内容（读不到回退 HEAD）。
   */
  private async parsePorcelain(
    porcelain: string,
    context: CaptureContext,
  ): Promise<FileSnapshotEntry[]> {
    if (porcelain.length === 0) {
      return [];
    }
    const parts = porcelain.split('\0');
    const entries: FileSnapshotEntry[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';
      if (part.length === 0) continue;
      // 行格式：`<XY> <path>`（XY 为 2 字符状态，其后一个空格，再是路径）。
      const status = part.slice(0, 2);
      const renamed = status.includes('R') || status.includes('C');
      if (renamed) {
        // `-z` 的重命名/复制格式（实测）：`XY 新路径\0旧路径\0`。
        // 旧实现把两个 NUL 片段都当成独立记录，旧路径片段会解析出伪路径（如 `xt`），
        // restore 时 `rm` 可能删掉工作区里的同名无关文件。
        const newPath = part.slice(3);
        const oldPath = parts[++index] ?? '';
        if (newPath.length > 0) {
          entries.push(await this.entryFor(context, newPath, 'head'));
        }
        if (oldPath.length > 0) {
          // 快照时刻旧路径已不在（重命名已完成）⇒ 回滚时必须删除它；若磁盘上还在
          //（未完全落地的重命名），则按实际内容捕获，仍以快照时刻为准。
          entries.push(await this.entryFor(context, oldPath, 'delete'));
        }
        continue;
      }
      const relPath = part.slice(3);
      if (relPath.length === 0) continue;
      // 删除：快照时刻文件已不在磁盘，回滚目标为 HEAD 版本（重建）；其余状态优先捕获
      // 快照时刻磁盘上的实际内容（读不到再回退 HEAD）。
      entries.push(await this.entryFor(context, relPath, 'head'));
    }
    return entries;
  }

  /**
   * 为一个路径生成快照条目：优先读快照时刻磁盘内容。
   * @param context 捕获上下文。
   * @param relPath 相对路径。
   * @param missing 磁盘读不到时的语义：`head`＝回退 HEAD 内容；`delete`＝回滚时删除（null）。
   * @returns 快照条目。
   */
  private async entryFor(
    context: CaptureContext,
    relPath: string,
    missing: 'head' | 'delete',
  ): Promise<FileSnapshotEntry> {
    const full = resolve(context.root, relPath);
    try {
      const info = await stat(full);
      if (!info.isFile()) {
        return GitWorkspaceSnapshot.skipped(relPath, 'not-a-regular-file');
      }
      if (info.size > context.budget.maxFileBytes) {
        return GitWorkspaceSnapshot.skipped(
          relPath,
          `too-large: ${String(info.size)} bytes > ${String(context.budget.maxFileBytes)}`,
        );
      }
      return this.captureBytes(relPath, await readFile(full), context.budget);
    } catch {
      if (missing === 'delete') {
        return { relPath, content: null };
      }
      try {
        return this.captureBytes(
          relPath,
          await GitWorkspaceSnapshot.gitBytes(['show', `HEAD:${relPath}`], context.root),
          context.budget,
        );
      } catch {
        return { relPath, content: null };
      }
    }
  }

  /**
   * 把字节转成快照条目（文本走 UTF-8，二进制走 base64；超总量预算则 skipped）。
   * @param relPath 相对路径。
   * @param bytes 原始字节。
   * @param budget 累计预算（成功捕获时累加）。
   * @returns 快照条目。
   */
  private captureBytes(relPath: string, bytes: Buffer, budget: CaptureBudget): FileSnapshotEntry {
    if (bytes.byteLength > budget.maxFileBytes) {
      return GitWorkspaceSnapshot.skipped(
        relPath,
        `too-large: ${String(bytes.byteLength)} bytes > ${String(budget.maxFileBytes)}`,
      );
    }
    if (budget.usedBytes + bytes.byteLength > budget.maxTotalBytes) {
      return GitWorkspaceSnapshot.skipped(
        relPath,
        `snapshot-budget: ${String(budget.usedBytes + bytes.byteLength)} bytes > ${String(
          budget.maxTotalBytes,
        )}`,
      );
    }
    budget.usedBytes += bytes.byteLength;
    const text = bytes.toString('utf8');
    // 只有「UTF-8 往返逐字节相等」才按文本存；否则（二进制/非法编码）走 base64。
    // 不能只看 NUL：0x80–0xFF 的非 UTF-8 字节同样会被替换成 U+FFFD。
    const roundTrip = Buffer.from(text, 'utf8');
    if (roundTrip.length === bytes.length && roundTrip.equals(bytes)) {
      return { relPath, content: text };
    }
    return { relPath, content: bytes.toString('base64'), encoding: 'base64' };
  }

  /** 构造「已跳过」条目（restore 时保留现场，不删除）。
   * @param relPath 相对路径。
   * @param reason 跳过原因。
   * @returns 跳过条目。
   */
  private static skipped(relPath: string, reason: string): FileSnapshotEntry {
    return { relPath, content: null, skipped: true, skipReason: reason };
  }

  /** 将快照写回工作树。
   * @param root 工作树根目录。
   * @param snapshot 先前 {@link capture} 产出的快照（仅手术式覆盖/删除其中列出的文件）。
   *
   * @returns 无返回值。
   */
  public async restore(root: string, snapshot: FileSnapshot): Promise<void> {
    for (const entry of snapshot.entries) {
      // 跳过的条目 = 没有安全捕获，不能当成删除（那会毁掉现场）。
      if (entry.skipped === true) {
        continue;
      }
      const full = resolve(root, entry.relPath);
      if (entry.content === null) {
        await rm(full, { force: true });
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      const bytes =
        entry.encoding === 'base64'
          ? Buffer.from(entry.content, 'base64')
          : Buffer.from(entry.content, 'utf8');
      await writeFile(full, bytes);
    }
  }

  /**
   * 运行 git 子命令，返回 stdout 文本（失败抛错）。
   * @param args git 参数列表（不含可执行名）。
   * @param cwd 工作树目录（git 执行上下文）。
   * @returns git 标准输出文本；命令失败（含非仓库）时 reject（fail-closed）。
   */
  private static git(args: readonly string[], cwd: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err !== null) {
          reject(err);
          return;
        }
        resolvePromise(stdout);
      });
    });
  }

  /**
   * 运行 git 子命令，返回**原始字节**（供二进制 `git show`）。
   * @param args git 参数列表（不含可执行名）。
   * @param cwd 工作树目录。
   * @returns stdout 字节；失败 reject。
   */
  private static gitBytes(args: readonly string[], cwd: string): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        [...args],
        { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout) => {
          if (err !== null) {
            reject(err);
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
  }

  /** 归一化正数选项（非法/非正回落默认）。
   * @param value 输入值。
   * @param fallback 默认值。
   * @returns 正数。
   */
  private static positiveOr(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  }
}
