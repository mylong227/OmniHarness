/**
 * bash 命名空间的应用根映射器。
 *
 * ## 为什么需要**第二个** `/app` 映射
 *
 * 同一个 `/app` 在两个命名空间里是两条不同的路径：
 * - **Python / 操作系统视角**：`Path("/app/x")` 在 Windows 上解析为 `<盘>:\\app\\x`
 *   —— 由 {@link AppRootMapper} 用盘根链接覆盖；
 * - **MSYS/Git-Bash 视角**：`cat /app/x` 里的 `/` 是 MSYS 根（`.../PortableGit/versions/<v>`），
 *   于是 `/app` = `<MSYS_ROOT>/app`，**和盘根那个完全无关**。
 *
 * 参考解（`solution.sh`）与 Agent 的 shell 命令都活在第二个视角里，判分器活在第一个视角里。
 * 只覆盖一个，就会出现「Agent 写的文件判分器看不见」这种最难查的假失败。
 * 本类覆盖第二个视角，做法与第一个完全相同：**在 MSYS 根下建目录联接**。
 *
 * ## 失败时的定位
 *
 * 找不到 bash（或 MSYS 根不可写）**不算环境失败**：判分走 Python，照样能判。
 * 代价只是「参考解跑不了、Agent 用不了 POSIX 路径」——因此这里返回告警而不是错误，
 * 由调用方决定是否因此放弃某个 Solver。把便利设施的缺失说成环境失败，会掩盖真实原因。
 */
import { existsSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from './types.js';
import { BashLocator } from './bashLocator.js';

/** 一次 bash 命名空间映射的凭据。 */
export interface BashAppRootClaim {
  /** bash 视角的 `/app` 所在路径。 */
  readonly bashAppRoot: string;
  /** MSYS 根目录。 */
  readonly msysRoot: string;
  /**
   * 释放映射。
   *
   * @returns 无返回值。
   */
  release(): void;
}

/** bash 命名空间应用根映射器。 */
export class BashAppRootMapper {
  /** 已解析的 bash 路径（`undefined` 未解析，`null` 表示未找到）。 */
  private bash: string | null | undefined;

  /** 已解析的 MSYS 根（`undefined` 未解析）。 */
  private msysRoot: string | null | undefined;

  /** 最近一次失败原因。 */
  private lastError: string | null = null;

  /**
   * @param run 执行命令的接缝（用于向 bash 询问它的根目录）。
   */
  public constructor(private readonly run: CommandRunner) {}

  /**
   * 夺取 bash 视角的 `/app`。
   *
   * @param appDir 本次任务的一次性应用目录。
   * @param msysWorkdir 执行询问命令时的工作目录（须存在）。
   * @returns 映射凭据；无法映射为 null。
   */
  public async claim(appDir: string, msysWorkdir: string): Promise<BashAppRootClaim | null> {
    const msysRoot = await this.resolveMsysRoot(msysWorkdir);
    if (msysRoot === null) {
      return null;
    }
    const bashAppRoot = join(msysRoot, 'app');
    if (existsSync(bashAppRoot)) {
      this.lastError = `${bashAppRoot} 已存在；请移走后重试`;
      return null;
    }
    try {
      symlinkSync(appDir, bashAppRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
    return {
      bashAppRoot,
      msysRoot,
      release: (): void => {
        BashAppRootMapper.unlink(bashAppRoot);
      },
    };
  }

  /**
   * 当前是否具备建映射的前提（找不到 bash 时给出原因，供报告如实展示）。
   *
   * @returns null 表示可用；否则为原因（**不是**环境失败，只是便利能力缺失）。
   */
  public reason(): string | null {
    return (
      this.lastError ??
      (this.bashPath() === null ? '本机未找到 bash，参考解与 POSIX 路径命令不可用' : null)
    );
  }

  /**
   * bash 绝对路径。
   *
   * @returns 绝对路径；未找到为 null。
   */
  public bashPath(): string | null {
    if (this.bash === undefined) {
      this.bash = BashLocator.locate();
    }
    return this.bash;
  }

  /**
   * 解析 MSYS 根目录。
   *
   * 先向 bash 询问（`cd / && pwd -W` 是权威答案，能处理包装器与自定义安装），
   * 再退回按路径推断。只解析一次。
   *
   * @param workdir 执行询问命令的工作目录。
   * @returns MSYS 根目录；不可用为 null。
   */
  private async resolveMsysRoot(workdir: string): Promise<string | null> {
    if (this.msysRoot !== undefined) {
      return this.msysRoot;
    }
    const bash = this.bashPath();
    if (bash === null) {
      this.msysRoot = null;
      return null;
    }
    if (process.platform !== 'win32') {
      // POSIX 上 MSYS 概念不存在，`/` 就是真根；如果 `/app` 能建，上面那步已经建好了。
      const outcome = await this.run([bash, '-lc', 'cd / && pwd -P'], workdir, {}, 20_000);
      this.msysRoot =
        outcome.exitCode === 0 && outcome.stdout.trim() !== '' ? outcome.stdout.trim() : null;
      return this.msysRoot;
    }
    const outcome = await this.run([bash, '-lc', 'cd / && pwd -W'], workdir, {}, 20_000);
    const printed = outcome.stdout.trim();
    if (outcome.exitCode === 0 && printed !== '') {
      this.msysRoot = printed.replace(/\//g, '\\');
      return this.msysRoot;
    }
    this.msysRoot = BashLocator.inferMsysRoot(bash);
    return this.msysRoot;
  }

  /**
   * 删除链接本体（不跟随到目标）。
   *
   * @param path 链接路径。
   * @returns 无返回值（best-effort）。
   */
  private static unlink(path: string): void {
    try {
      if (process.platform === 'win32') {
        rmdirSync(path);
      } else {
        unlinkSync(path);
      }
    } catch {
      try {
        rmSync(path, { force: true });
      } catch {
        // best-effort
      }
    }
  }
}
