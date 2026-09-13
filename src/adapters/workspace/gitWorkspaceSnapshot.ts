import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  FileSnapshot,
  FileSnapshotEntry,
  WorkspaceSnapshotPort,
} from '../../ports/workspaceSnapshot.js';

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
function git(args: readonly string[], cwd: string): Promise<string> {
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
    await git(['rev-parse', '--is-inside-work-tree'], root);
    const porcelain = await git(['status', '--porcelain', '-z'], root);
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
    const parts = porcelain.split('\0').filter((part) => part.length > 0);
    const entries: FileSnapshotEntry[] = [];
    for (const part of parts) {
      // 行格式：`<XY> <path>`（XY 为 2 字符状态，其后一个空格，再是路径）；
      // rename/copy 为 `<XY> <old>\0<new>`（路径间以 NUL 分隔）。取首路径即可。
      const status = part.slice(0, 2);
      const relPath = part.slice(3).split('\0')[0] ?? '';
      if (relPath.length === 0) {
        continue;
      }
      if (status[0] === 'D' || status[1] === 'D') {
        // 删除：快照时刻文件已不在磁盘，回滚目标为 HEAD 版本（重建）。
        entries.push({ relPath, content: await this.headContent(root, relPath) });
        continue;
      }
      // 其余（M/A/R/C/U/??）：捕获**快照时刻磁盘上的实际内容**，使回滚回到该点状态。
      try {
        const content = await readFile(resolve(root, relPath), 'utf8');
        entries.push({ relPath, content });
      } catch {
        // 读取失败（极少数竞态）按 HEAD 重建处理。
        entries.push({ relPath, content: await this.headContent(root, relPath) });
      }
    }
    return entries;
  }

  /** 读取文件在 HEAD 的内容；取不到返回 null（视为回滚时删除）。
   * @param root 工作树根目录。
   * @param relPath 相对工作树根的文件路径。
   * @returns HEAD 版本内容；文件未被跟踪或 git show 失败时为 null。
   */
  private async headContent(root: string, relPath: string): Promise<string | null> {
    try {
      return await git(['show', `HEAD:${relPath}`], root);
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
}
