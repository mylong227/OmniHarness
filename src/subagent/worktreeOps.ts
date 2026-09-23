import { execFile } from 'node:child_process';
import { log } from '../util/logger.js';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cpSync, mkdirSync, promises as fsp } from 'node:fs';

/**
 * WorktreeOps 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class WorktreeOps {
  /**
   * C7 收口：原顶层内部函数迁入宿主类。
   * @param repoRoot string
   * @param fn () => Promise<T>
   * @returns Promise<T>
   */
  public static withWorktreeLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const prev = worktreeLocks.get(repoRoot) ?? Promise.resolve();
    let release!: () => void;
    const ticket = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktreeLocks.set(
      repoRoot,
      prev.then(() => ticket).catch(() => undefined),
    );
    return prev.then(fn).finally(release);
  }
  /**
   * 清洗为 git 分支安全字符（仅保留字母数字、点、下划线、连字符）。
   * @param name string
   * @returns string
   */
  public static sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '-');
  }
  /**
   * C7 收口：原顶层内部函数迁入宿主类。
   * @param repoRoot string
   * @param name string
   * @returns Promise<Worktree>
   */
  public static async createWorktreeUnsafe(repoRoot: string, name: string): Promise<Worktree> {
    const safe = WorktreeOps.sanitizeName(name);
    const wtPath = join(repoRoot, WORKTREE_DIR, safe);
    const branch = `omni-sub-${safe}`;

    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath], { cwd: repoRoot });
      return {
        path: wtPath,
        isolated: 'worktree',
        cleanup: async () => {
          // 2026-09-22 修（审计 P3）：清理此前**在锁外**跑、且失败被静默吞掉
          // ⇒ 并发派生/结束时抢 git 锁会残留 `.omni-worktrees/<id>` 与 `omni-sub-*` 分支，
          // 而且没有任何日志可归因。现与创建共用同一把按 repoRoot 的锁，失败一律 log.warn。
          await WorktreeOps.withWorktreeLock(repoRoot, async () => {
            await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], {
              cwd: repoRoot,
            }).catch((error: unknown) => {
              log.warn('worktree.cleanup.failed', {
                repoRoot,
                path: wtPath,
                step: 'worktree-remove',
                error: String(error),
              });
            });
            await execFileAsync('git', ['branch', '-D', branch], { cwd: repoRoot }).catch(
              (error: unknown) => {
                log.warn('worktree.cleanup.failed', {
                  repoRoot,
                  branch,
                  step: 'branch-delete',
                  error: String(error),
                });
              },
            );
          });
        },
      };
    } catch {
      // fail-closed：目录拷贝隔离，明确非 worktree 隔离。
      // 隔离区放在 repoRoot 之外（os.tmpdir），避免把目录拷进自身子目录而触发
      // ERR_FS_CP_EINVAL 自拷贝错误；同时过滤运行时/依赖目录（.git / .omni-* /
      // node_modules / dist），既不污染隔离区，也避免并发派生时拷到别的子智能体
      // 仍在占用的 .omni-storage 而 EIO（Access is denied）。
      const copyPath = join(tmpdir(), `omni-wt-${safe}`);
      mkdirSync(copyPath, { recursive: true });
      cpSync(repoRoot, copyPath, {
        recursive: true,
        filter: (src) =>
          !src.includes('.git') &&
          !src.includes(WORKTREE_DIR) &&
          !src.includes('.omni-storage') &&
          !src.includes('node_modules') &&
          !src.includes('dist'),
      });
      return {
        path: copyPath,
        isolated: 'copy',
        cleanup: async () => {
          await fsp.rm(copyPath, { recursive: true, force: true });
        },
      };
    }
  }
}

const execFileAsync = promisify(execFile);

/**
 * @beta
 * git worktree 隔离结果。
 */
export interface Worktree {
  /** 隔离后的文件系统根（子智能体的 workspaceRoot）。 */
  readonly path: string;
  /**
   * 隔离方式：
   * - 'worktree'：基于 git worktree 的真实分支隔离；
   * - 'copy'：git 不可用或失败时的安全降级（整目录拷贝）。
   */
  readonly isolated: 'worktree' | 'copy';
  /** 释放隔离资源（worktree 模式移除 worktree；copy 模式删除目录）。 */
  cleanup(): Promise<void>;
}

/** 子智能体隔离工作树根目录名。 */
const WORKTREE_DIR = '.omni-worktrees';

/**
 * 按 repoRoot 串行化工作树创建/清理，避免多个子智能体并发派生时
 * 对同一个 .omni-worktrees 目录的创建与拷贝竞态（Windows 下表现为 EIO/Access denied）。
 * 返回一条 promise 链，每次调用挂在上一次之后执行。
 */
const worktreeLocks = new Map<string, Promise<unknown>>();

/**
 * 为某个子智能体创建隔离的文件系统工作树。
 *
 * 优先使用 git worktree 分支隔离；当 git 不可用或命令失败时，fail-closed
 * 降级为整目录拷贝（绝不静默共享父工作区），并在结果中标记 isolated:'copy'。
 */
export async function createWorktree(repoRoot: string, name: string): Promise<Worktree> {
  return WorktreeOps.withWorktreeLock(repoRoot, () =>
    WorktreeOps.createWorktreeUnsafe(repoRoot, name),
  );
}

/**
 * 创建隔离工作树 → 执行 fn(path) → 无论成败均 cleanup（finally）。
 */
export async function withWorktree<T>(
  repoRoot: string,
  name: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const worktree = await createWorktree(repoRoot, name);
  try {
    return await fn(worktree.path);
  } finally {
    await worktree.cleanup();
  }
}
