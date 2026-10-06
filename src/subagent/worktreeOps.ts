import { execFile } from 'node:child_process';
import { log } from '../util/logger.js';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cpSync, mkdirSync, promises as fsp, writeFileSync } from 'node:fs';

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
   *
   * 时间上界（2026-10-01 审计）：此处 git 调用原先**无 timeout、无取消** —— 凭证交互提示、
   * `.git/index.lock` 争用、Windows Defender 扫描等都会让命令阻塞不返回；而调用点位于
   * 子代理并发闸门**内部**，且 `subagent` 在调度器里是串行屏障，一个挂住的 worktree
   * 创建会把整个回合永久黑洞。故每条 git 命令一律带 {@link GIT_TIMEOUT_MS} 上界，
   * 并透传会话取消信号（中止 ⇒ 命令即杀，走目录拷贝降级路径）。
   *
   * @param repoRoot string
   * @param name string
   * @param signal AbortSignal | undefined
   * @returns Promise<Worktree>
   */
  public static async createWorktreeUnsafe(
    repoRoot: string,
    name: string,
    signal?: AbortSignal | undefined,
  ): Promise<Worktree> {
    const safe = WorktreeOps.sanitizeName(name);
    const wtPath = join(repoRoot, WORKTREE_DIR, safe);
    const branch = `omni-sub-${safe}`;

    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath], {
        cwd: repoRoot,
        timeout: GIT_TIMEOUT_MS,
        signal,
      });
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
              timeout: GIT_TIMEOUT_MS,
            }).catch((error: unknown) => {
              log.warn('worktree.cleanup.failed', {
                repoRoot,
                path: wtPath,
                step: 'worktree-remove',
                error: String(error),
              });
            });
            await execFileAsync('git', ['branch', '-D', branch], {
              cwd: repoRoot,
              timeout: GIT_TIMEOUT_MS,
            }).catch((error: unknown) => {
              log.warn('worktree.cleanup.failed', {
                repoRoot,
                branch,
                step: 'branch-delete',
                error: String(error),
              });
            });
          });
        },
      };
    } catch (error) {
      // 取消与超时都不降级为整目录拷贝：目录拷贝是重 IO（大仓可到 GB 级），取消后再拷
      // 等于把「用户喊停」变成「更久地不停」；直接向上抛，由调用方转为失败结果。
      if (signal?.aborted === true) {
        throw error instanceof Error ? error : new Error(String(error));
      }
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

  /**
   * 为某个子智能体创建隔离的文件系统工作树。
   *
   * 优先使用 git worktree 分支隔离；当 git 不可用或命令失败时，fail-closed
   * 降级为整目录拷贝（绝不静默共享父工作区），并在结果中标记 isolated:'copy'。
   * @param repoRoot 仓库根目录（worktree 挂载基准）。
   * @param name 子智能体名（清洗后作分支与目录名）。
   * @param signal 会话取消信号（可选）：给出时在飞 git 命令随取消中止，不再等其自然完成。
   * @returns 隔离工作树（含清理回调）。
   */
  public static async createWorktree(
    repoRoot: string,
    name: string,
    signal?: AbortSignal | undefined,
  ): Promise<Worktree> {
    return WorktreeOps.withWorktreeLock(repoRoot, () =>
      WorktreeOps.createWorktreeUnsafe(repoRoot, name, signal),
    );
  }

  /**
   * 创建隔离工作树 → 执行 fn(path) → 无论成败均 cleanup（finally）。
   */
  public static async withWorktree<T>(
    repoRoot: string,
    name: string,
    fn: (path: string) => Promise<T>,
  ): Promise<T> {
    const worktree = await WorktreeOps.createWorktree(repoRoot, name);
    try {
      return await fn(worktree.path);
    } finally {
      await worktree.cleanup();
    }
  }

  /**
   * 采集改动时**必须排除**的运行期目录（相对隔离树根）。
   *
   * 为什么必须有它：子会话的存储被重定位到隔离工作树内（`SubagentRuntimeFactory`），
   * 于是 `.omni-storage/<子会话>.jsonl` 天然出现在 `git status` 里。不排除的实测后果
   * （2026-10-06 真实模型跑测）：两个子代理的 patch 各是 **24–32 KB 的会话日志**，
   * 改动清单只报「`.omni-storage/sess_xxx.jsonl`」这**一个**文件——主代理收到的是
   * 「有改动 + 一份日志」，据此**把噪声当业务改动**，而真正的源码改动在哪一无所知。
   *
   * 与 `.gitignore` 的分工：这**不能**只靠用户的 `.gitignore`——它未必覆盖 `.omni-storage/`
   * （本仓 `.gitignore` 就只写了 `.omniharness/`），而采集是对**任意用户工作区**都要成立的机制。
   */
  private static readonly RUNTIME_EXCLUDE: readonly string[] = [
    '.omni-storage',
    '.omniharness',
    '.omni-worktrees',
    'node_modules',
  ];

  /**
   * git pathspec 的「递归通配」后缀。
   *
   * 为什么拆成常量：审计规则 `scripts/auditStandards.mjs` 的「JSDoc 续行缩进」检查用 TS scanner
   * 逐个 token 扫，遇到**模板字面量里的**注释起始符号会误判成注释起点、把后面的真 JSDoc 一起吞掉
   * （该规则已修，见 `jsdocIndentViolations` 的模板分支）；这里同时用常量拼接，让后缀只有一处定义。
   */
  private static readonly PATHSPEC_GLOB = `/${'**'}`;

  /**
   * 采集隔离工作树里的**改动**为 unified patch（2026-10-03 第六轮修看板 §8.1）。
   *
   * 存在理由：子代理的写入落在隔离工作树里，而 `cleanup()` 是 `git worktree remove --force`
   * **+ `git branch -D`** ⇒ 改动**静默消失**（父代理仍收到 `ok:true`）。本方法在清理**之前**把改动
   * 取出来，交给编排层落盘成可 `git apply` 的工件。
   *
   * 口径：
   *  - 先 `git add -A`——否则**未跟踪文件**（子代理最常产出的形态：新建文件）不会进 diff；
   *  - **排除运行期目录**（{@link RUNTIME_EXCLUDE}）：子会话自己的会话存储（`.omni-storage/*.jsonl`）
   *    就落在隔离树里，若不排除，patch 会变成几十 KB 的会话日志、改动清单只剩那一个文件，
   *    主代理据此**把噪声当成业务改动**（2026-10-06 真实模型跑测实测的误导性证据）；
   *  - patch 用 `git diff --cached --binary HEAD`（二进制也标记得出）；
   *  - 超过 {@link PATCH_MAX_BYTES} 时只保留前一段并置 `truncated`（**不抛错**：采集是增强，
   *    不得因为一次大改动让子代理结果变成失败）。
   * @param wtPath 隔离工作树路径。
   * @returns 改动文件列表 + patch（无改动时两者皆空）。
   */
  public static async collectChanges(wtPath: string): Promise<WorktreeChanges> {
    const exclude = WorktreeOps.RUNTIME_EXCLUDE.map(
      (dir) => `:(exclude)${dir}${WorktreeOps.PATHSPEC_GLOB}`,
    );
    await execFileAsync('git', ['add', '-A', '--', '.', ...exclude], {
      cwd: wtPath,
      timeout: GIT_TIMEOUT_MS,
    });
    const status = await execFileAsync('git', ['status', '--porcelain', '--', '.', ...exclude], {
      cwd: wtPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BYTES,
    });
    const files = status.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
    if (files.length === 0) {
      return { files: [], patch: '', truncated: false };
    }
    try {
      const diff = await execFileAsync('git', ['diff', '--cached', '--binary', 'HEAD'], {
        cwd: wtPath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: PATCH_MAX_BYTES * 2,
      });
      if (diff.stdout.length > PATCH_MAX_BYTES) {
        return { files, patch: diff.stdout.slice(0, PATCH_MAX_BYTES), truncated: true };
      }
      return { files, patch: diff.stdout, truncated: false };
    } catch {
      // 超大 / 超时 / git 异常：保留文件清单（这部分便宜且足够让调用方知道"有改动"），patch 标为截断。
      return { files, patch: '', truncated: true };
    }
  }

  /**
   * 把改动 patch 落到工作区内的运行目录（gitignored），返回**工作区相对路径**供 `git apply`。
   * @param workspaceRoot 工作区根（绝对路径）。
   * @param sessionId 子会话 ID（文件名）。
   * @param changes 采集到的改动。
   * @returns 落盘信息（相对路径在 POSIX 分隔口径下）。
   */
  public static async persistChanges(
    workspaceRoot: string,
    sessionId: string,
    changes: WorktreeChanges,
  ): Promise<{ readonly relativePath: string; readonly bytes: number }> {
    const dir = join(workspaceRoot, SUBAGENT_PATCH_DIR);
    mkdirSync(dir, { recursive: true });
    const name = `${WorktreeOps.sanitizeName(sessionId)}.patch`;
    const abs = join(dir, name);
    const body =
      `${changes.patch}\n` +
      (changes.truncated
        ? '# [omni] patch 因超过上限被截断（上方为前一段），完整改动请查子会话轨迹\n'
        : '');
    writeFileSync(abs, body, 'utf8');
    return {
      relativePath: `${SUBAGENT_PATCH_DIR}/${name}`,
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  }
}

const execFileAsync = promisify(execFile);

/**
 * 单条 git 命令的时间上界（毫秒）。
 *
 * 本地 worktree add/remove/branch -D 都是毫秒级操作；30s 已覆盖最慢的
 * `.git/index.lock` 争用与杀毒扫描，再久必然是挂住（凭证提示 / 死锁）而非慢。
 * 存在理由见 `createWorktreeUnsafe` 注释（无上界 + 卡在并发闸门内 = 整回合黑洞）。
 */
const GIT_TIMEOUT_MS = 30_000;

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

/** 子代理改动 patch 的落盘目录（工作区内、已被 `.gitignore` 的 `.omniharness/`）。 */
const SUBAGENT_PATCH_DIR = '.omniharness/subagent-patches';

/** 单个 patch 的字节上限（超过即截断并标注；4 MiB 远大于正常代码改动）。 */
const PATCH_MAX_BYTES = 4 * 1024 * 1024;
/** `git status --porcelain` 的输出上限（仅文件清单，1 MiB 足够）。 */
const STATUS_MAX_BYTES = 1024 * 1024;

/**
 * @beta
 * 隔离工作树里的改动快照（回并 / 审计用）。
 */
export interface WorktreeChanges {
  /** 改动的相对路径（含未跟踪文件）。 */
  readonly files: readonly string[];
  /** 相对 HEAD 的 unified diff（含未跟踪文件；二进制带 `--binary` 标记）。 */
  readonly patch: string;
  /** patch 是否因超过上限被截断（`files` 仍然完整）。 */
  readonly truncated: boolean;
}

/** 子智能体隔离工作树根目录名。 */
const WORKTREE_DIR = '.omni-worktrees';

/**
 * 按 repoRoot 串行化工作树创建/清理，避免多个子智能体并发派生时
 * 对同一个 .omni-worktrees 目录的创建与拷贝竞态（Windows 下表现为 EIO/Access denied）。
 * 返回一条 promise 链，每次调用挂在上一次之后执行。
 */
const worktreeLocks = new Map<string, Promise<unknown>>();
