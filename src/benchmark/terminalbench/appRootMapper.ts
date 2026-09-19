/**
 * 应用根映射器：让判分脚本看到的 `/app` **就是**本次任务的一次性应用目录。
 *
 * 上游任务把工作目录写成容器里的 `/app`（`Path("/app/data.parquet")`、
 * `COPY data.csv ./`、`WORKDIR /app`），判分脚本里这批绝对路径是**写死的**。
 * 若不提供 `/app`，任何原生执行都只能把这类题记成环境失败——那等于没替换掉容器。
 *
 * 本类的做法是**用操作系统自己的链接原语**把 `/app` 指过去：
 * - Windows：`<盘>:\\app` 目录联接（junction）。**不需要管理员权限**
 *   （符号链接才需要；联接不需要），这是本方案能在普通用户态落地的关键。
 * - POSIX：`/app` 符号链接（需要 `/` 可写；GH Actions 之类的 runner 上 `sudo` 可用）。
 *
 * 语义等价性：容器把宿主目录挂到 `/app`，这里把宿主目录**链接**到 `/app`；
 * 对判分脚本来说两者都只是「`/app` 下有那些文件」，读写都落到同一个真实目录。
 *
 * ## 已知边界（写在这里而不是散在注释里）
 *
 * - `/app` 是**全机唯一名字** ⇒ 同一时刻只能有一个任务占据它。
 *   这与「一个容器一个 `/app`」在并发度上等价：本适配器因此在映射生效时**要求串行**
 *   （见 `NativeExecutionBackend.prepare` 的 `serialize` 提示），不做假并行。
 * - 若 `/app` 已被**真实目录**占用（用户自己的东西），本类**绝不改动它**，
 *   直接返回可执行的原因（`请移走 /app 或改用 --no-app-map`），由运行器记环境失败。
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, parse as parsePath, sep } from 'node:path';

/** 一次映射的凭据（`release()` 幂等）。 */
export interface AppRootClaim {
  /** 容器视角的应用根路径（Windows 为 `<盘>:\\app`，POSIX 为 `/app`）。 */
  readonly canonicalPath: string;
  /**
   * 释放映射。
   *
   * @returns 无返回值。
   */
  release(): void;
}

/** 应用根映射器。 */
export class AppRootMapper {
  /** 未指定 `--no-app-map` 时的默认容器工作目录。 */
  public static readonly CONTAINER_APP_ROOT = '/app';

  /** 是否启用映射（关闭时 `claim` 恒返回 null，由调用方决定是否降级）。 */
  private readonly enabled: boolean;

  /** 最近一次建链失败的原因（用于把「为什么建不上」说清楚，而不是笼统报不可用）。 */
  private lastError: string | null = null;

  /**
   * @param enabled 是否启用映射（默认 true）。
   */
  public constructor(enabled = true) {
    this.enabled = enabled;
  }

  /**
   * 夺取容器视角的应用根，把它指向 `appDir`。
   *
   * 注意**不要**顺手 `mkdirSync(<盘根>, {recursive:true})`：Windows 上对已存在的盘根
   * 做递归创建会抛 `EPERM`（Node 仍会尝试创建该目录项），而它一旦落进下面的 catch，
   * 就把真正要做的建链接也一起吞掉——本类首次落地时正是这么「静默失败」的。
   * 盘根是否可写由建链接本身决定，不需要预先创建。
   *
   * @param appDir 本次任务的一次性应用目录（已创建）。
   * @returns 映射凭据；无法映射时返回 null（调用方据 {@link reason} 记环境失败）。
   */
  public claim(appDir: string): AppRootClaim | null {
    if (!this.enabled) {
      return null;
    }
    const canonical = AppRootMapper.canonicalPathFor(appDir);
    const existing = AppRootMapper.describe(canonical);
    if (existing === 'foreign-link' || existing === 'foreign-dir') {
      return null;
    }
    if (existing === 'ours') {
      AppRootMapper.unlink(canonical);
    }
    try {
      // Windows 用 junction（免管理员）；POSIX 用普通符号链接。
      symlinkSync(appDir, canonical, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      this.lastError = AppRootMapper.message(error);
      return null;
    }
    return {
      canonicalPath: canonical,
      release: (): void => {
        AppRootMapper.unlink(canonical);
      },
    };
  }

  /**
   * 是否启用映射（供后端判断是否需要串行执行）。
   *
   * @returns 启用时为 true。
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 预检：本机能不能建立映射（用于报告里自述环境能力，避免逐题重复失败）。
   *
   * 会**真的建一次再删掉**，而不是读文档推断：能不能在盘根建链接取决于目录权限，
   * 只有试过才知道。探测失败时返回的原因带上「为什么」，让人能直接去改。
   *
   * @returns 可用时为 null；不可用时为人类可读且**可执行**的原因。
   */
  public reason(): string | null {
    if (!this.enabled) {
      return '应用根映射被显式关闭（--no-app-map）：判分脚本里的 /app 绝对路径将无法解析';
    }
    const canonical = AppRootMapper.canonicalPathFor(process.cwd());
    const existing = AppRootMapper.describe(canonical);
    if (existing === 'foreign-dir') {
      return `${canonical} 已被真实目录占用；请移走后重试，或改用 --no-app-map（后者会把依赖 /app 的任务记为环境失败）`;
    }
    if (existing === 'foreign-link') {
      return `${canonical} 已被其他链接占用；请移走后重试`;
    }
    const probeRoot = `${parsePath(canonical).root || '.'}${sep}`;
    let probeDir = '';
    try {
      probeDir = mkdtempSync(join(probeRoot, '.omni-approot-'));
    } catch (error) {
      return `无法在 ${probeRoot} 下创建目录（${AppRootMapper.message(error)}）；原生执行需要在该盘根建立 ${canonical} 链接，请改用可写盘作为工作目录，或加 --no-app-map`;
    }
    const probe = this.claim(probeDir);
    if (probe === null) {
      AppRootMapper.removeDir(probeDir);
      const detail = this.lastError === null ? '' : `：${this.lastError}`;
      return `无法建立 ${canonical} 链接（盘根不可写或已存在同名链接）${detail}；请改用可写盘作为工作目录，或加 --no-app-map`;
    }
    probe.release();
    AppRootMapper.removeDir(probeDir);
    return null;
  }

  /**
   * 计算 `/app` 在本平台上的**真实解析路径**。
   *
   * Python 里 `Path('/app/x')` 在 Windows 上解析为 `<当前盘>:\\app\\x`，
   * 而判分进程的工作目录正是应用目录 ⇒ 盘符取 `appDir` 所在盘。
   *
   * @param appDir 应用目录。
   * @returns 容器视角应用根的真实路径。
   */
  public static canonicalPathFor(appDir: string): string {
    if (process.platform !== 'win32') {
      return AppRootMapper.CONTAINER_APP_ROOT;
    }
    const root = parsePath(appDir).root;
    return join(root === '' ? `${sep}` : root, 'app');
  }

  /**
   * 判断某路径当前是什么。
   *
   * @param path 待判定路径。
   * @returns `absent` / `ours`（指向的链接）/ `foreign-link` / `foreign-dir`。
   */
  private static describe(path: string): 'absent' | 'ours' | 'foreign-link' | 'foreign-dir' {
    if (!existsSync(path)) {
      return 'absent';
    }
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return 'ours';
      }
    } catch {
      return 'foreign-dir';
    }
    return 'foreign-dir';
  }

  /**
   * 删除链接本体（**不跟随**到目标，避免误删应用目录内容）。
   *
   * @param path 链接路径。
   * @returns 无返回值（失败静默——清场失败不该毁掉整轮）。
   */
  private static unlink(path: string): void {
    try {
      // Windows 的目录联接用 rmdir 摘除；POSIX 的符号链接用 unlink。
      if (process.platform === 'win32') {
        rmdirSync(path);
      } else {
        unlinkSync(path);
      }
    } catch {
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * 删除探测目录（best-effort）。
   *
   * @param dir 目录路径。
   * @returns 无返回值。
   */
  private static removeDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  /**
   * 把未知异常收敛成一句可读原因。
   *
   * @param error 异常。
   * @returns 原因文本。
   */
  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
