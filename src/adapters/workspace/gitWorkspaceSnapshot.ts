import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FileSnapshot, FileSnapshotEntry, WorkspaceSnapshotPort } from '../../ports/workspaceSnapshot.js';

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

/** 运行 git 子命令，返回 stdout（失败抛错）。 */
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

export class GitWorkspaceSnapshot implements WorkspaceSnapshotPort {
  public readonly name = 'git';

  /** 捕获会话触碰文件相对 HEAD 的差异。 */
  public async capture(root: string): Promise<FileSnapshot> {
    // 校验为 git 仓库（非仓库则下面的命令会抛错，fail-closed）。
    await git(['rev-parse', '--is-inside-work-tree'], root);
    const porcelain = await git(['status', '--porcelain', '-z'], root);
    const entries = await this.parsePorcelain(porcelain, root);
    return { root: resolve(root), entries };
  }

  /** 解析 `git status --porcelain -z` 输出为文件快照条目。 */
  private async parsePorcelain(
    porcelain: string,
    root: string,
  ): Promise<FileSnapshotEntry[]> {
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

  /** 读取文件在 HEAD 的内容；取不到返回 null（视为回滚时删除）。 */
  private async headContent(root: string, relPath: string): Promise<string | null> {
    try {
      return await git(['show', `HEAD:${relPath}`], root);
    } catch {
      return null;
    }
  }

  /** 将快照写回工作树。 */
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

/** 从磁盘读取已保存的快照 JSON（供 CheckpointManager 持久化使用）。 */
export async function readSnapshotFile(path: string): Promise<FileSnapshot> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as FileSnapshot;
}

/** 将快照写入磁盘 JSON。 */
export async function writeSnapshotFile(path: string, snapshot: FileSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
}
