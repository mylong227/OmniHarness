/**
 * PTY（伪终端）能力探测与分级（纯静态、无状态，可脱离真终端单测）。
 *
 * ## 为什么需要分级
 *
 * 交互式程序（vim / htop / 交互式安装器）只有在拿到**真终端**时行为才正确；把它接到管道上
 * 轻则输出错乱、重则直接拒绝启动。历史上本仓只有一条路：Unix 用 GNU `script` 包一层伪终端，
 * Windows 直接 fail-closed——这等于「Windows 上永远做不了交互式会话」。
 *
 * 但「父进程本来就在真终端里跑」这件事本身就够用：子进程用 `stdio: 'inherit'`
 * 拿到的就是同一个真终端（这正是各类 CLI 编码代理在 Windows 上的通行做法）。
 * 故本类给出三级判定，**逐级降级但绝不静默退化成管道**：
 *
 * 1. `pty-wrapper`：Unix 上找得到 GNU `script` ⇒ 包一层真 PTY（能力最强，子进程看到独立终端）；
 * 2. `inherit`：父进程 stdin/stdout 都是 TTY ⇒ 子进程直接继承同一个真终端；
 * 3. `unavailable`：两者都不成立 ⇒ fail-closed，给出**可执行**的补救建议。
 *
 * 判定输入全部可注入（平台 / TTY / `script` 是否存在 / 查找目录），故单测**不需要真的开 TTY、
 * 也不需要装 `script`**，且探测本身**不 spawn 任何进程**（只用文件系统检查，避免把
 * 子进程权限/超时问题引入探测路径）。
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ShellInvocation } from './shellInvocation.js';

/** PTY 能力等级（按优先级从高到低）。 */
export type PtyMode = 'pty-wrapper' | 'inherit' | 'unavailable';

/** 探测输入（全部可注入，便于跨平台确定性单测）。 */
export interface PtyProbe {
  /** 平台名（默认 `process.platform`）。 */
  readonly platform?: string | undefined;
  /** 父进程是否持有可继承的真终端（默认按 stdin + stdout 的 isTTY 判定）。 */
  readonly hasTty?: boolean | undefined;
  /** GNU `script` 是否可用（默认按 {@link PtyCapability.scriptAvailable} 探测）。 */
  readonly scriptAvailable?: boolean | undefined;
  /** 查找 `script` 的候选目录（缺省 PATH + {@link PtyCapability.FALLBACK_DIRS}）。 */
  readonly searchDirs?: readonly string[] | undefined;
}

/** 探测结论。 */
export interface PtyReport {
  /** 命中的能力等级。 */
  readonly mode: PtyMode;
  /** 是否可用（`unavailable` 时为 false）。 */
  readonly available: boolean;
  /** 判定所用平台名。 */
  readonly platform: string;
  /** 父进程是否持有真终端。 */
  readonly hasTty: boolean;
  /** 是否探测到 GNU `script`。 */
  readonly scriptAvailable: boolean;
  /** 人话原因；不可用时即 fail-closed 的**可执行**原因。 */
  readonly reason: string;
}

/**
 * PTY 能力探测器（无状态，纯静态）。
 */
export class PtyCapability {
  /** GNU `script`（util-linux）的可执行文件名。 */
  public static readonly SCRIPT_BINARY = 'script';

  /** PATH 之外的兜底查找目录（POSIX 惯例位置）。 */
  public static readonly FALLBACK_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'] as const;

  private constructor() {}

  /**
   * 父进程是否持有可继承的真终端：stdin 与 stdout **必须同时**是 TTY。
   *
   * 只判 stdout 是不够的——没有 stdin 的终端无法交互（读不到按键），会把「半交互」
   * 伪装成「可交互」。故从严判定。
   *
   * @returns 两者都是 TTY 时为 true。
   */
  public static ttyAvailable(): boolean {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  }

  /**
   * 探测 GNU `script` 是否存在于候选目录（**纯文件系统检查，不 spawn 进程**）。
   *
   * @param platform 平台名（`win32` 恒 false——Windows 无 `script`）。
   * @param searchDirs 候选目录（缺省 PATH + {@link PtyCapability.FALLBACK_DIRS}）。
   * @returns 找到 `script` 时为 true。
   */
  public static scriptAvailable(
    platform: string = process.platform,
    searchDirs?: readonly string[],
  ): boolean {
    if (platform === 'win32') {
      return false;
    }
    const dirs = searchDirs ?? PtyCapability.defaultSearchDirs();
    return dirs.some((dir) => dir !== '' && existsSync(join(dir, PtyCapability.SCRIPT_BINARY)));
  }

  /**
   * 分级探测当前可用的交互式路径。
   *
   * @param probe 探测输入（不传则按真实进程环境判定）。
   * @returns 探测结论（含 fail-closed 的可执行原因）。
   */
  public static detect(probe: PtyProbe = {}): PtyReport {
    const platform = probe.platform ?? process.platform;
    const hasTty = probe.hasTty ?? PtyCapability.ttyAvailable();
    const scriptAvailable =
      probe.scriptAvailable ?? PtyCapability.scriptAvailable(platform, probe.searchDirs);
    const common = { platform, hasTty, scriptAvailable };
    if (scriptAvailable) {
      return {
        ...common,
        mode: 'pty-wrapper',
        available: true,
        reason: '检测到 GNU `script` ⇒ 以伪终端（PTY）包装执行，子进程看到独立真终端。',
      };
    }
    if (hasTty) {
      const nativeNote =
        platform === 'win32'
          ? '（Windows 原生无 pseudo-terminal，直通父进程终端正是交互式 TUI 的正确形态）'
          : '（未找到 `script`，退回直通；交互式程序同样能拿到真终端）';
      return {
        ...common,
        mode: 'inherit',
        available: true,
        reason: `父进程持有真终端（stdin/stdout 均为 TTY）⇒ 子进程以 stdio: 'inherit' 继承同一终端${nativeNote}。`,
      };
    }
    return {
      ...common,
      mode: 'unavailable',
      available: false,
      reason: PtyCapability.failClosedReason(platform),
    };
  }

  /**
   * 构造一次交互式执行的 argv（`unavailable` 时返回 null，调用方据此 fail-closed）。
   *
   * @param command 命令文本。
   * @param report 探测结论（决定包装形态）。
   * @param shell shell 可执行文件（缺省 {@link ShellInvocation.path}；测试可显式传入）。
   * @returns `{ bin, args }`；不可用时 null（**绝不**退化成管道 argv）。
   */
  public static argvOf(
    command: string,
    report: PtyReport,
    shell: string = ShellInvocation.path(),
  ): { readonly bin: string; readonly args: readonly string[] } | null {
    if (!report.available) {
      return null;
    }
    if (report.mode === 'pty-wrapper') {
      return ShellInvocation.ptyCommand(command, report.platform, shell);
    }
    return { bin: shell, args: ShellInvocation.args(shell, command, report.platform) };
  }

  /**
   * 缺省候选目录：PATH 各段 + 兜底目录（去空段，顺序即优先级）。
   *
   * @param env 环境变量表（默认 `process.env`）。
   * @returns 候选目录列表。
   */
  private static defaultSearchDirs(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): readonly string[] {
    const fromPath = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
    return [...fromPath, ...PtyCapability.FALLBACK_DIRS];
  }

  /**
   * 不可用时的 fail-closed 原因（分平台，且必须**可执行**：给出下一步做什么）。
   *
   * @param platform 平台名。
   * @returns 人话原因文本（含 `fail-closed` 字样，便于断言与排错）。
   */
  private static failClosedReason(platform: string): string {
    if (platform === 'win32') {
      return (
        '交互式执行不可用：stdin/stdout 不是 TTY（无终端可继承），且 Windows 原生无 pseudo-terminal' +
        '⇒ fail-closed，不静默退化为管道执行。可执行：1) 在真实终端（Windows Terminal / conhost / ' +
        '交互式 pwsh 窗口）中启动本进程后重试——子进程会继承该终端；2) 改用 shell 工具跑非交互命令。'
      );
    }
    return (
      '交互式执行不可用：未找到 GNU `script`（util-linux），且 stdin/stdout 不是 TTY（无终端可继承）' +
      '⇒ fail-closed，不静默退化为管道执行。可执行：1) 安装 util-linux 以提供 `script`；' +
      '2) 在真实终端中启动本进程（子进程将继承该终端）；3) 改用 shell 工具跑非交互命令。'
    );
  }
}
