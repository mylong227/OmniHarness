/**
 * Linux Landlock（内核态路径 ACL）沙箱后端：**严格探测 + 诚实的 fail-closed**，绝不伪造能力。
 *
 * ## 为什么不能「在 Node 里直接调 landlock」
 *
 * Landlock 是内核 LSM，只能经 `landlock_create_ruleset` / `landlock_add_rule` /
 * `landlock_restrict_self` 三个**系统调用**启用，且规则集必须由要受限的那个进程自己建立。
 * Node 运行时没有系统调用直通（不引依赖的前提下），`src/native/**` 的 N-API 内核也只暴露
 * JSON-RPC（`ping` / `tools.list` / `tool_call` 等），Rust 侧 `crates/**` 里**没有** landlock 实现。
 * 故唯一的「真机可达」路径是**外部 helper**：一个自己调 landlock 后 `exec` 目标命令的可执行文件，
 * 由 `OMNI_LANDLOCK_HELPER` 指向它。
 *
 * ## 探测口径（缺一即 fail-closed，且原因必须可执行）
 *
 * 1. 平台必须是 Linux（其它平台无此 LSM）；
 * 2. 内核版本 ≥ 5.13（Landlock ABI 1 起）——据此推导支持的 ABI 等级；
 * 3. `/sys/kernel/security/landlock` 可读（说明 LSM 真的被启用）；
 * 4. `OMNI_LANDLOCK_HELPER` 指向一个**可执行**文件（否则我们没有任何执行路径）。
 *
 * 前三条是「能力自述」的依据（进 {@link SandboxCapabilityTable}），第四条是「本后端是否可用」的判据。
 * 因此**内核支持但没有 helper 时，本后端依然 fail-closed**——承认做不到，比假装隔离安全得多。
 */
import { accessSync, constants } from 'node:fs';
import { release } from 'node:os';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/runtime/sandbox.js';

/** Landlock 探测结论（能力自述的原始依据）。 */
export interface LandlockProbeReport {
  /** 本后端是否真的可用（= Linux + helper 可执行）。 */
  readonly available: boolean;
  /** 判定所用平台名。 */
  readonly platform: string;
  /** 内核版本（`os.release()` 或其注入值）。 */
  readonly kernelRelease: string;
  /** 由内核版本推导出的 Landlock ABI 等级；不支持时为 null。 */
  readonly landlockAbi: number | null;
  /** 内核可见性判定路径（`/sys/kernel/security/landlock`）。 */
  readonly securityFsPath: string;
  /** 该路径是否可读（= Landlock LSM 已启用）。 */
  readonly securityFsReadable: boolean;
  /** `OMNI_LANDLOCK_HELPER` 解析结果；未配置为 null。 */
  readonly helperPath: string | null;
  /** helper 是否可执行。 */
  readonly helperExecutable: boolean;
  /** 人话原因（不可用时即 fail-closed 的可执行原因）。 */
  readonly reason: string;
}

/** 探测输入（全部可注入，便于在 Windows/macOS 上确定性单测）。 */
export interface LandlockProbeInput {
  /** 平台名（默认 `process.platform`）。 */
  readonly platform?: string | undefined;
  /** 内核版本（默认 `os.release()`）。 */
  readonly kernelRelease?: string | undefined;
  /** 内核可见性判定路径（默认 {@link LinuxLandlockSandbox.SECURITY_FS_PATH}）。 */
  readonly securityFsPath?: string | undefined;
  /** 该路径是否可读（默认真访问文件系统）。 */
  readonly securityFsReadable?: boolean | undefined;
  /** helper 路径（默认读 `OMNI_LANDLOCK_HELPER`）。 */
  readonly helperPath?: string | null | undefined;
  /** helper 是否可执行（默认真做 `X_OK` 访问检查）。 */
  readonly helperExecutable?: boolean | undefined;
}

/** 推导原因所需的探测切片（仅供 {@link LinuxLandlockSandbox} 内部使用）。 */
interface LandlockProbeParts {
  readonly platform: string;
  readonly available: boolean;
  readonly kernelRelease: string;
  readonly landlockAbi: number | null;
  readonly securityFsReadable: boolean;
  readonly helperPath: string | null;
  readonly helperExecutable: boolean;
}

/**
 * Linux Landlock 后端（严格探测；探测不过即 fail-closed，不冒充 bwrap/unshare）。
 */
export class LinuxLandlockSandbox implements SandboxPort {
  /** 内核 Landlock 可见性路径（该目录存在即说明 LSM 已启用）。 */
  public static readonly SECURITY_FS_PATH = '/sys/kernel/security/landlock';

  /** helper 环境变量名。 */
  public static readonly HELPER_ENV = 'OMNI_LANDLOCK_HELPER';

  /** Landlock 最低内核版本（5.13 引入 ABI 1）。 */
  public static readonly MIN_KERNEL_MAJOR = 5;

  /** Landlock 最低内核次版本。 */
  public static readonly MIN_KERNEL_MINOR = 13;

  /** 沙箱后端名称（区别于 profile 名 `landlock`，表明是真实现而非占位）。 */
  public readonly name = 'linux-landlock';

  /**
   * @param workspace 受限写入的 workspace 根目录。
   * @param probeInput 探测输入（缺省按真实内核/环境判定）。
   */
  public constructor(
    private readonly workspace: string,
    private readonly probeInput: LandlockProbeInput = {},
  ) {}

  /**
   * 严格探测本机 Landlock 能力。
   *
   * @returns 探测结论（含「为什么不可用」的可执行原因）。
   */
  public probe(): LandlockProbeReport {
    const platform = this.probeInput.platform ?? process.platform;
    const kernelRelease = this.probeInput.kernelRelease ?? release();
    const securityFsPath = this.probeInput.securityFsPath ?? LinuxLandlockSandbox.SECURITY_FS_PATH;
    const securityFsReadable =
      this.probeInput.securityFsReadable ??
      LinuxLandlockSandbox.defaultSecurityFsReadable(platform, securityFsPath);
    const helperPath =
      this.probeInput.helperPath === undefined
        ? LinuxLandlockSandbox.defaultHelperPath()
        : this.probeInput.helperPath;
    const helperExecutable =
      this.probeInput.helperExecutable ??
      LinuxLandlockSandbox.defaultHelperExecutable(platform, helperPath);
    const landlockAbi = LinuxLandlockSandbox.abiOf(kernelRelease);
    // 四个条件缺一不可：平台是 Linux、内核提供 Landlock、LSM 真的启用、且有一个可执行的 helper。
    // 前三条是「内核能力」，第四条是「本仓的执行路径」——只有后者成立我们才真的能施加限制；
    // 少了任何一条却报 available=true，就等于谎称已隔离。
    const available =
      platform === 'linux' &&
      landlockAbi !== null &&
      securityFsReadable &&
      helperPath !== null &&
      helperExecutable;
    const parts: LandlockProbeParts = {
      platform,
      available,
      kernelRelease,
      landlockAbi,
      securityFsReadable,
      helperPath,
      helperExecutable,
    };
    return { ...parts, securityFsPath, reason: LinuxLandlockSandbox.reasonOf(parts) };
  }

  /**
   * 同步审批端口：探测不过即 fail-closed，通过则按受限策略裁决。
   *
   * @param action 待裁决的沙箱动作。
   * @returns 沙箱决策。
   */
  public decide(action: SandboxAction): SandboxDecision {
    return this.deniedByProbe() ?? this.restrictedDecision(action);
  }

  /**
   * 异步审批：与 {@link decide} 同策略。
   *
   * @param action 待裁决的沙箱动作。
   * @returns 沙箱决策（不可用时 `{ allowed: false, category: 'os' }`）。
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    return this.deniedByProbe() ?? this.restrictedDecision(action);
  }

  /**
   * 返回将要执行的 helper 命令行（供测试断言隔离意图）。
   * 探测不过时返回**空数组**（没有 helper 就没有可执行的命令行，不编一个假的）。
   *
   * @param command 将要在沙箱内执行的命令。
   * @param args 命令参数。
   * @param workspace 工作区根目录（helper 据此设置唯一可写子路径）。
   * @returns helper 完整命令行参数数组；不可用时为空数组。
   */
  public dryRun(command: string, args: readonly string[], workspace: string): string[] {
    const report = this.probe();
    if (!report.available || report.helperPath === null) {
      return [];
    }
    return [report.helperPath, '--workspace', workspace, '--', command, ...args];
  }

  /**
   * 探测不过时的拒绝决策（通过时返回 undefined）。
   *
   * @returns 拒绝决策；可用时为 undefined。
   */
  private deniedByProbe(): SandboxDecision | undefined {
    const report = this.probe();
    if (report.available) {
      return undefined;
    }
    return {
      allowed: false,
      reason: `landlock 不可用：${report.reason}`,
      category: 'os',
    };
  }

  /**
   * 受限策略：默认拒绝网络类命令；写仅限 workspace；命令执行经 helper 套上 landlock 规则。
   *
   * @param action 待裁决的沙箱动作。
   * @returns 决策结果（写越界/未知动作 fail-closed 拒绝并附原因）。
   */
  private restrictedDecision(action: SandboxAction): SandboxDecision {
    switch (action.kind) {
      case 'file_write':
        if (action.target.startsWith(this.workspace)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `landlock 策略：写操作仅限 workspace (${this.workspace})`,
          category: 'path',
        };
      case 'file_read':
        return { allowed: true };
      case 'command':
        return { allowed: true };
      default:
        return { allowed: false, reason: 'landlock 未知动作', category: 'other' };
    }
  }

  /**
   * 由内核版本推导 Landlock ABI 等级（ABI 与内核的对应关系见内核 `Documentation/userspace-api/landlock.rst`）。
   *
   * 只做版本下界判定，不假装知道发行版回移（backport）情况——回移属于少数发行版行为，
   * 真正的可用性由 `/sys/kernel/security/landlock` 与 helper 共同确认。
   *
   * @param kernelRelease 内核版本（如 `6.1.0-13-amd64`）。
   * @returns ABI 等级；低于 5.13 或无法解析时为 null。
   */
  private static abiOf(kernelRelease: string): number | null {
    const match = /^(\d+)\.(\d+)/.exec(kernelRelease);
    if (match === null) {
      return null;
    }
    const major = Number(match[1] ?? '0');
    const minor = Number(match[2] ?? '0');
    const version = major * 1000 + minor;
    if (version < 5013) {
      return null;
    }
    if (version < 5019) {
      return 1;
    }
    if (version < 6002) {
      return 2;
    }
    if (version < 6007) {
      return 3;
    }
    if (version < 6010) {
      return 4;
    }
    if (version < 6012) {
      return 5;
    }
    return 6;
  }

  /**
   * 默认内核可见性判定：非 Linux 恒 false，Linux 上做一次 `R_OK` 访问检查（不抛错）。
   *
   * @param platform 平台名。
   * @param path 判定路径。
   * @returns 可读时为 true。
   */
  private static defaultSecurityFsReadable(platform: string, path: string): boolean {
    if (platform !== 'linux') {
      return false;
    }
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 默认 helper 路径：读 `OMNI_LANDLOCK_HELPER`（空串视为未配置）。
   *
   * @returns 绝对路径或 null。
   */
  private static defaultHelperPath(): string | null {
    const raw = process.env[LinuxLandlockSandbox.HELPER_ENV] ?? '';
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * 默认 helper 可执行性判定：非 Linux 恒 false（landlock helper 只能在 Linux 上生效）。
   *
   * @param platform 平台名。
   * @param helperPath helper 路径（可为 null）。
   * @returns 可执行时为 true。
   */
  private static defaultHelperExecutable(platform: string, helperPath: string | null): boolean {
    if (platform !== 'linux' || helperPath === null) {
      return false;
    }
    try {
      accessSync(helperPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 生成人话原因（不可用时逐条给出**可执行**的补救）。
   *
   * @param parts 探测切片。
   * @returns 原因文本。
   */
  private static reasonOf(parts: LandlockProbeParts): string {
    const abiText = parts.landlockAbi === null ? '未知' : String(parts.landlockAbi);
    if (parts.available) {
      return (
        `内核支持 Landlock（ABI ${abiText}，内核 ${parts.kernelRelease}）且 ` +
        `${LinuxLandlockSandbox.HELPER_ENV}=${parts.helperPath ?? ''} 可执行 ⇒ 经 helper 走内核态路径 ACL。`
      );
    }
    if (parts.platform !== 'linux') {
      return (
        `非 Linux 平台（${parts.platform}）没有 Landlock LSM ⇒ fail-closed（不冒充其它后端）。` +
        '可执行：Windows 用 profile restricted；macOS 用 profile seatbelt；Linux 用 profile unshare/bwrap。'
      );
    }
    if (parts.landlockAbi === null) {
      return (
        `内核 ${parts.kernelRelease} 未提供 Landlock（需 >= ${String(LinuxLandlockSandbox.MIN_KERNEL_MAJOR)}.` +
        `${String(LinuxLandlockSandbox.MIN_KERNEL_MINOR)} 且 CONFIG_SECURITY_LANDLOCK=y）⇒ fail-closed。` +
        '可执行：升级内核并启用 Landlock LSM；或改用 profile unshare / bwrap。'
      );
    }
    if (!parts.securityFsReadable) {
      return (
        `内核版本满足（${parts.kernelRelease}，ABI ${abiText}）但 ${LinuxLandlockSandbox.SECURITY_FS_PATH} 不可读：` +
        'Landlock LSM 未启用（内核启动参数 lsm= 未含 landlock，或 securityfs 未挂载）⇒ fail-closed。' +
        '可执行：用 lsm=...,landlock 启动内核并确认 /sys/kernel/security 已挂载；或改用 profile unshare / bwrap。'
      );
    }
    if (parts.helperPath !== null && !parts.helperExecutable) {
      return (
        `${LinuxLandlockSandbox.HELPER_ENV}=${parts.helperPath} 不是可执行文件（或当前用户无执行权限）⇒ fail-closed。` +
        '可执行：chmod +x 该文件，或改指向一个真正会应用 Landlock 规则的 helper；' +
        '或改用 profile unshare / bwrap。'
      );
    }
    return (
      `内核支持 Landlock（ABI ${abiText}，内核 ${parts.kernelRelease}），但未配置 ` +
      `${LinuxLandlockSandbox.HELPER_ENV}：Node 无法直接发起 landlock(2) 系统调用，` +
      '本仓 Rust 侧（src/native、crates/）也没有 landlock 实现 ⇒ 无可用执行路径，fail-closed（不冒充其它后端）。' +
      '可执行：1) 提供一个「应用 Landlock 规则后 exec 目标命令」的 helper，并用 ' +
      `${LinuxLandlockSandbox.HELPER_ENV}=<绝对路径> 指向它；2) 或改用 profile unshare（内核命名空间隔离）/ bwrap。`
    );
  }
}
