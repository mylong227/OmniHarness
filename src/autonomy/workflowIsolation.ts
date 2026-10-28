import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OmniHome } from '../util/omniHome.ts';

/**
 * 工作流 worktree 级隔离（2026-10-29，A5）。
 *
 * 在独立 git worktree 里跑步骤，成功才把改动以二进制 patch 形式应用回主工作区；
 * 失败则丢弃。只支持 git 仓库（非 git 工作区 fail-closed，不静默退化）。
 */
export class WorkflowIsolation {
  private constructor(
    /** 隔离工作区根（worktree 路径）。 */
    public readonly root: string,
    private readonly repoRoot: string,
  ) {}

  /**
   * 创建隔离 worktree。
   * @param repoRoot 主工作区（必须是 git 仓库根或其子目录）。
   * @returns 隔离句柄。
   * @throws Error 非 git 仓库 / worktree 创建失败。
   */
  public static create(repoRoot: string): WorkflowIsolation {
    const tempRoot = OmniHome.tmpRoot();
    mkdirSync(tempRoot, { recursive: true });
    const temp = mkdtempSync(join(tempRoot, 'omni-wf-'));
    // git worktree add 要求目标不存在或为空；mkdtemp 已建空目录，先删掉让 git 自己建。
    rmSync(temp, { recursive: true, force: true });
    try {
      execFileSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], {
        stdio: 'ignore',
      });
      execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', temp, 'HEAD'], {
        stdio: 'ignore',
      });
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw new Error(
        `workflow 隔离需要可用的 git 仓库（${repoRoot}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new WorkflowIsolation(temp, repoRoot);
  }

  /**
   * 把隔离工作区的全部改动应用回主工作区。
   * @returns 应用的字节数（0 表示无改动）。
   * @throws Error patch 冲突/应用失败。
   */
  public commit(): number {
    execFileSync('git', ['-C', this.root, 'add', '-A'], { stdio: 'ignore' });
    const patch = execFileSync('git', ['-C', this.root, 'diff', '--cached', '--binary', 'HEAD'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (patch.length === 0) return 0;
    execFileSync('git', ['-C', this.repoRoot, 'apply', '--binary', '-'], {
      input: patch,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    return patch.length;
  }

  /**
   * 丢弃隔离工作区（删除 worktree 与临时目录）。
   * @returns 无返回值。
   */
  public discard(): void {
    try {
      execFileSync('git', ['-C', this.repoRoot, 'worktree', 'remove', '--force', this.root], {
        stdio: 'ignore',
      });
    } catch {
      // worktree 已被手工删除时，remove 会失败；下面再兜底清目录。
    }
    if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true });
  }
}
