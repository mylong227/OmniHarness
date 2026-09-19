/**
 * 沙箱后端**统一能力自述**：把「哪个后端在本机能真跑、依据是什么、跑不了怎么办」变成一份
 * 可复现、可输出的数据，而不是散落在文档里的一句话。
 *
 * ## 为什么需要它
 *
 * 本仓的 OS 级沙箱长期处于「实现存在但没有真机证据」的状态：`bwrap` / `sandbox-exec` 是真实现
 * （探测不到二进制即 fail-closed），`landlock` 有严格探测 + helper 委派，`restricted` 在 Windows 上
 * 真跑，但这些结论此前只写在代码注释与 README 里——**没人能在机器上把它复现出来**，
 * 于是「占位」与「真实现」在叙事上等价，审计只能靠人读代码。
 *
 * 本表把判定集中到一处，并保证两件事：
 * 1. **同源**：判定逻辑与运行时后端一致（平台 + 二进制探测 + Landlock 探测报告），不另写一套；
 * 2. **可输出**：{@link SandboxCapabilityTable.format} 产出人可读表格，供 `omniharness doctor` 直接打印。
 *
 * 探测**不 spawn 任何进程**（只做文件系统/环境判定），因此该表可以在任何平台、任何权限下安全生成。
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { LinuxLandlockSandbox } from './linuxLandlockSandbox.js';
import type { LandlockProbeReport } from './linuxLandlockSandbox.js';
import type { SandboxProfile } from './sandboxManager.js';

/** 单个后端的能力自述。 */
export interface SandboxCapabilityEntry {
  /** profile 名（与 `--sandbox` 取值一致）。 */
  readonly profile: SandboxProfile;
  /** 实际承载该 profile 的后端名（用于识别「profile 名 ≠ 实现」的映射）。 */
  readonly backend: string;
  /** 本机是否**真机可达**（不是「代码存在」）。 */
  readonly real: boolean;
  /** 判定依据（平台/二进制/内核探测结论）。 */
  readonly basis: string;
  /** 跑不了时的可执行补救；真机可达时为空串。 */
  readonly actionable: string;
}

/** 能力表输入（全部可注入，便于跨平台确定性单测）。 */
export interface SandboxCapabilityInput {
  /** 平台名（默认 `process.platform`）。 */
  readonly platform?: string | undefined;
  /** 命令存在性判定（默认按 PATH 做纯文件系统扫描，不 spawn `which`）。 */
  readonly commandExists?: ((command: string) => boolean) | undefined;
  /** 进程是否已提权（仅 Windows 有意义；默认 false，避免把未提权误报成可用）。 */
  readonly elevated?: boolean | undefined;
  /** Landlock 探测报告（默认按真实内核/环境探测）。 */
  readonly landlock?: LandlockProbeReport | undefined;
}

/**
 * 沙箱后端能力表（无状态，纯静态）。
 */
export class SandboxCapabilityTable {
  /** 表内 profile 的顺序（与 `--sandbox` 帮助一致：策略类在前，OS 级在后）。 */
  public static readonly PROFILES: readonly SandboxProfile[] = [
    'passthrough',
    'policy',
    'restricted',
    'landlock',
    'seatbelt',
    'bwrap',
    'unshare',
  ];

  private constructor() {}

  /**
   * 生成本机的能力自述表。
   *
   * @param workspaceRoot 工作区根（Landlock 探测需要它来构造后端实例）。
   * @param input 探测输入（可注入，便于跨平台单测）。
   * @returns 各 profile 的能力条目（顺序同 {@link SandboxCapabilityTable.PROFILES}）。
   */
  public static describe(
    workspaceRoot: string,
    input: SandboxCapabilityInput = {},
  ): readonly SandboxCapabilityEntry[] {
    const platform = input.platform ?? process.platform;
    const commandExists =
      input.commandExists ??
      ((command: string): boolean => SandboxCapabilityTable.commandOnPath(command, platform));
    const landlock = input.landlock ?? new LinuxLandlockSandbox(workspaceRoot).probe();
    return [
      ...SandboxCapabilityTable.policyEntries(input.elevated ?? false),
      SandboxCapabilityTable.landlockEntry(landlock),
      ...SandboxCapabilityTable.osEntries(platform, commandExists),
    ];
  }

  /**
   * 纯 TS 策略类条目（不依赖任何 OS 能力，故在**所有**平台上都真机可达）。
   *
   * @param elevated 当前进程是否已提权（仅影响 Windows RestrictedToken 的说明）。
   * @returns passthrough / policy / restricted 三条。
   */
  private static policyEntries(elevated: boolean): readonly SandboxCapabilityEntry[] {
    return [
      {
        profile: 'passthrough',
        backend: 'passthrough',
        real: true,
        basis: '纯直通（不做任何隔离），不依赖 OS 能力',
        actionable: '仅用于调试与对照实验；生产请用 policy/restricted 或 OS 级后端',
      },
      {
        profile: 'policy',
        backend: 'policy',
        real: true,
        basis: '纯 TS 策略（危险命令黑名单 + 工作区路径白名单），零 OS 依赖',
        actionable: '',
      },
      {
        profile: 'restricted',
        backend: 'restricted',
        real: true,
        basis:
          '纯 TS 强化策略（policy 规则 + 网络外联/提权命令黑名单）；' +
          'Windows 上的真 OS 级隔离由 Rust RestrictedToken（`--native` 路径）提供，' +
          `当前进程${elevated ? '已' : '未'}提权`,
        actionable: elevated
          ? ''
          : 'Windows 上创建受限令牌需要管理员权限：以管理员身份重启即可让 RestrictedToken 真正生效',
      },
    ];
  }

  /**
   * 构造 Landlock 条目（判定委托给后端自身的严格探测，保证与运行时同源）。
   *
   * @param landlock Landlock 探测报告。
   * @returns Landlock 能力条目。
   */
  private static landlockEntry(landlock: LandlockProbeReport): SandboxCapabilityEntry {
    return {
      profile: 'landlock',
      backend: 'linux-landlock',
      real: landlock.available,
      basis: landlock.reason,
      actionable: landlock.available ? '' : '见依据列的 fail-closed 原因与补救步骤',
    };
  }

  /**
   * 构造三个「平台 + 二进制」型 OS 级条目。
   *
   * @param platform 当前平台名。
   * @param commandExists 命令存在性判定。
   * @returns seatbelt / bwrap / unshare 三条。
   */
  private static osEntries(
    platform: string,
    commandExists: (command: string) => boolean,
  ): readonly SandboxCapabilityEntry[] {
    return [
      SandboxCapabilityTable.osEntry(
        'seatbelt',
        'macos-seatbelt',
        platform === 'darwin' && commandExists('sandbox-exec'),
        platform,
        'darwin',
        'sandbox-exec',
        '安装 Xcode 命令行工具后 `which sandbox-exec` 应可命中；需在 macOS 真机验证',
      ),
      SandboxCapabilityTable.osEntry(
        'bwrap',
        'linux-bwrap',
        platform === 'linux' && commandExists('bwrap'),
        platform,
        'linux',
        'bwrap',
        '安装 bubblewrap（Debian/Ubuntu: apt install bubblewrap）；需在 Linux 真机验证',
      ),
      SandboxCapabilityTable.osEntry(
        'unshare',
        'linux-unshare',
        platform === 'linux' && commandExists('unshare'),
        platform,
        'linux',
        'unshare',
        '安装 util-linux 提供 `unshare`（多数发行版自带）；需在 Linux 真机验证',
      ),
    ];
  }

  /**
   * 把能力表格式化成可读文本（供 `doctor` 直接打印）。
   *
   * @param entries 能力条目（通常来自 {@link SandboxCapabilityTable.describe}）。
   * @returns 多行文本（不含结尾换行）。
   */
  public static format(entries: readonly SandboxCapabilityEntry[]): string {
    const lines: string[] = ['沙箱后端能力表（本机真机可达性自述）'];
    lines.push('--------------------------------------------------');
    for (const entry of entries) {
      lines.push(
        `  ${entry.profile.padEnd(12)} ${entry.backend.padEnd(16)} ` +
          `${entry.real ? '可达  ' : '不可达'} ${entry.basis}`,
      );
      if (entry.actionable !== '') {
        lines.push(`               ↳ ${entry.real ? '提示' : '可执行'}：${entry.actionable}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 构造一条 OS 级后端条目（平台 + 二进制两重判定，非目标平台恒不可达）。
   *
   * @param profile profile 名。
   * @param backend 后端名。
   * @param real 是否真机可达（调用方已按平台与二进制判定）。
   * @param platform 当前平台名。
   * @param targetPlatform 该后端要求的平台名。
   * @param binary 该后端依赖的二进制名。
   * @param installHint 二进制缺失时的安装提示。
   * @returns 能力条目。
   */
  private static osEntry(
    profile: SandboxProfile,
    backend: string,
    real: boolean,
    platform: string,
    targetPlatform: string,
    binary: string,
    installHint: string,
  ): SandboxCapabilityEntry {
    if (platform !== targetPlatform) {
      return {
        profile,
        backend,
        real: false,
        basis: `仅 ${targetPlatform} 可用，当前平台是 ${platform}（非目标平台不得误报可用）`,
        actionable: `在 ${targetPlatform} 真机上运行才能验证；当前平台请改用对应后端`,
      };
    }
    if (!real) {
      return {
        profile,
        backend,
        real: false,
        basis: `平台正确（${platform}）但 PATH 上找不到 \`${binary}\`，fail-closed`,
        actionable: installHint,
      };
    }
    return {
      profile,
      backend,
      real: true,
      basis: `平台 ${platform} 且 PATH 上可找到 \`${binary}\``,
      actionable: '',
    };
  }

  /**
   * 纯文件系统命令存在性判定（不 spawn `which`：Windows 上没有 which，且探测不该引入子进程权限面）。
   *
   * @param command 命令名。
   * @param platform 平台名（决定是否尝试 `.exe`/`.cmd` 后缀）。
   * @param env 环境变量表（默认 `process.env`，读 PATH）。
   * @returns 命中时为 true。
   */
  private static commandOnPath(
    command: string,
    platform: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): boolean {
    const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
    const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    return dirs.some((dir) =>
      suffixes.some((suffix) => existsSync(join(dir, `${command}${suffix}`))),
    );
  }
}
