import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
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
 */

/** 运行 git 子命令，返回 stdout（失败抛错）。
 * @param args git 参数列表（不含可执行名）。
 * @param cwd 工作树目录（git 执行上下文）。
 * @returns git 标准输出文本；命令失败（含非仓库）时 reject（fail-closed）。
 */

/** Git 工作区快照适配器：实现 WorkspaceSnapshotPort，适合 git 仓库内的工作树（按 HEAD 差异捕获/还原）。 */
export class GitWorkspaceSnapshot implements WorkspaceSnapshotPort {
  /** 适配器名，与端口契约一致：固定为 'git'。 */
  public readonly name = 'git';

  /** 捕获会话触碰文件相对 HEAD 的差异。
   * @param root 工作树根目录（须为 git 仓库，否则抛错）。
   * @returns 含根绝对路径与逐文件条目的快照（content 为回滚目标内容，null 表示回滚时删除）。
   */
  public async capture(root: string): Promise<FileSnapshot> {
    // 校验为 git 仓库（非仓库则下面的命令会抛错，fail-closed）。
    await GitWorkspaceSnapshot.git(['rev-parse', '--is-inside-work-tree'], root);
    const porcelain = await GitWorkspaceSnapshot.git(['status', '--porcelain', '-z'], root);
    const entries = await this.parsePorcelain(porcelain, root);
    return { root: resolve(root), entries };
  }

  /** 解析 `git status --porcelain -z` 输出为文件快照条目。
   * @param porcelain git status 的 NUL 分隔输出（含删除/修改/新增/重命名各状态行）。
   * @param root 工作树根目录（读取磁盘现内容用）。
   * @returns 快照条目列表：删除项取 HEAD 内容，其余取快照时刻磁盘内容（读不到回退 HEAD）。
   */
  private async parsePorcelain(porcelain: string, root: string): Promise<FileSnapshotEntry[]> {
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
          entries.push(await this.entryFor(root, newPath, 'head'));
        }
        if (oldPath.length > 0) {
          // 快照时刻旧路径已不在（重命名已完成）⇒ 回滚时必须删除它；若磁盘上还在
          //（未完全落地的重命名），则按实际内容捕获，仍以快照时刻为准。
          entries.push(await this.entryFor(root, oldPath, 'delete'));
        }
        continue;
      }
      const relPath = part.slice(3);
      if (relPath.length === 0) continue;
      // 删除：快照时刻文件已不在磁盘，回滚目标为 HEAD 版本（重建）；其余状态优先捕获
      // 快照时刻磁盘上的实际内容（读不到再回退 HEAD）。
      entries.push(await this.entryFor(root, relPath, 'head'));
    }
    return entries;
  }

  /**
   * 为一个路径生成快照条目：优先读快照时刻磁盘内容。
   * @param root 工作树根目录。
   * @param relPath 相对路径。
   * @param missing 磁盘读不到时的语义：`head`＝回退 HEAD 内容；`delete`＝回滚时删除（null）。
   * @returns 快照条目。
   */
  private async entryFor(
    root: string,
    relPath: string,
    missing: 'head' | 'delete',
  ): Promise<FileSnapshotEntry> {
    try {
      return { relPath, content: await readFile(resolve(root, relPath), 'utf8') };
    } catch {
      return {
        relPath,
        content: missing === 'delete' ? null : await this.headContent(root, relPath),
      };
    }
  }

  /** 读取文件在 HEAD 的内容；取不到返回 null（视为回滚时删除）。
   * @param root 工作树根目录。
   * @param relPath 相对工作树根的文件路径。
   * @returns HEAD 版本内容；文件未被跟踪或 git show 失败时为 null。
   */
  private async headContent(root: string, relPath: string): Promise<string | null> {
    try {
      return await GitWorkspaceSnapshot.git(['show', `HEAD:${relPath}`], root);
    } catch {
      return null;
    }
  }

  /** 将快照写回工作树。
   * @param root 工作树根目录。
   * @param snapshot 先前 {@link capture} 产出的快照（仅手术式覆盖/删除其中列出的文件）。
   
   * @returns 无返回值。
   */
  public async restore(root: string, snapshot: FileSnapshot): Promise<void> {
    for (const entry of snapshot.entries) {
      const full = resolve(root, entry.relPath);
      if (entry.content === null) {
        await rm(full, { force: true });
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, entry.content, 'utf8');
    }
  }
  /**
   * git — module-level helper moved into GitWorkspaceSnapshot.
   * @param {readonly string[]} args - args
   * @param {string} cwd - cwd
   * @returns {Promise<string>} - result
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
}
