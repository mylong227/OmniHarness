/**
 * `doctor` 诊断报告的**契约类型**（2026-10-11 从 `src/cli/doctorRunner.ts` 外迁，**逐字保留**）。
 *
 * 为什么外迁：Web 需要一个 `doctor.report` RPC 来渲染诊断面板，而实现（`DoctorRunner`）住在 CLI 层
 * —— `cli → server` 已存在，若让 `server → cli` 就会成环（架构门禁 `[5]` 新增环即红）。
 * 故把**类型**放端口层：CLI 侧照旧用实现并再导出（零改动），server 只依赖本契约，
 * 实现经 `AppServerOptions.doctorReport` 由 CLI **注入**（六边形该有的分工）。
 *
 * 判据 `tests/unit/doctorReportContract.test.ts` 会**逐字比对**本文件与 CLI 侧的再导出，
 * 防两侧漂移（本文件首版就是手抄错了 `SandboxStatus` 的字段名，被 tsc 当场抓到）。
 */
import type { InjectionSelfCheckSummary } from './injectionSelfCheckSummary.js';
import type { SandboxCapabilityEntry } from '../runtime/sandbox/sandboxCapabilityEntry.js';

/** doctor 选项：工作区根与显式配置文件路径。 */
export interface DoctorOptions {
  /** 工作区根（缺省=process.cwd()）。 */
  readonly workspaceRoot?: string | undefined;
  /** 显式配置文件路径（优先于向上查找 omniharness.json）。 */
  readonly configPath?: string | undefined;
}

/** 配置检查状态。 */
export interface ConfigStatus {
  /** 配置文件是否存在（含向上查找）。 */
  readonly exists: boolean;
  /** 存在时 JSON 是否合法。 */
  readonly valid: boolean;
  /** JSON 非法时的错误消息。 */
  readonly error?: string;
}

/** 沙箱后端可用性。 */
export interface SandboxStatus {
  /** Linux bubblewrap 是否可用。 */
  readonly bwrap: boolean;
  /** macOS sandbox-exec 是否可用。 */
  readonly sandboxExec: boolean;
  /** Windows RestrictedToken 沙箱（Windows 平台且进程已提权、真实可用时为 true）。 */
  readonly restrictedToken: boolean;
}

/**
 * **安全边界自述**（G5，2026-10-03）：把"当前实际隔离到什么程度"变成可复核的诊断输出。
 *
 * 为什么要单列：看板 §8.5 登记的"声明强于实现"三处（默认档是纯 TS 策略、Windows 受限令牌无
 * restricting SID、网络守卫只包 `fetch`）此前只存在于审计记录里。诊断输出若不转述它们，
 * 使用者会默认"有沙箱 = 已隔离"。本段的值**全部取自单一事实来源**（能力表 / 网络守卫自述 /
 * 信任档阈值），不在本文件另写一套声明——否则修了一处、另一处仍在撒谎。
 */
export interface SecurityBoundary {
  /**
   * 隔离强度档：`L2` ＝ 同用户进程内约束（无内核强制）；`L3` ＝ 内核强制（命名空间/LSM/seatbelt）。
   *
   * 判据是"生效档位对应的后端**在本机真机可达**且**内核强制**"，不是"代码里存在这个后端"。
   */
  readonly isolationLevel: 'L2' | 'L3';
  /** 判定依据（人可读，含具体档位与是否内核强制）。 */
  readonly isolationBasis: string;
  /** 生效的沙箱档（来自工作区配置；缺省 `policy`）。 */
  readonly sandboxProfile: string;
  /** 该档是否由内核强制（`policy` / `restricted` / `passthrough` 为 false）。 */
  readonly kernelEnforced: boolean;
  /** 网络守卫**实际**覆盖的外联入口（来自 `NetworkEgressGuard.COVERAGE`）。 */
  readonly networkGuardSurfaces: readonly string[];
  /** shell 子进程是否受网络守卫约束（恒 false ⇒ shell 出网不被拦）。 */
  readonly shellEgressGuarded: boolean;
  /** 网络守卫自述依据。 */
  readonly networkGuardBasis: string;
  /** 提示注入护栏的生效模式（未配置 ⇒ `off`）。 */
  readonly injectionMode: string;
  /** 各来源信任级的弱证据阈值（含记忆档，便于肉眼核对收紧是否生效）。 */
  readonly injectionThresholds: Readonly<Record<string, number>>;
}

/** doctor 诊断报告。 */
export interface DoctorReport {
  /** Node 版本。 */
  readonly nodeVersion: string;
  /** 配置文件检查。 */
  readonly config: ConfigStatus;
  /** 沙箱后端可用性。 */
  readonly sandbox: SandboxStatus;
  /** OS 沙箱能力自述（每个后端能否在本机真跑、依据是什么）。 */
  readonly sandboxCapabilities: readonly SandboxCapabilityEntry[];
  /** 安全边界自述（实际隔离到什么程度；G5）。 */
  readonly security: SecurityBoundary;
  /**
   * 注入护栏离线自检（curated 代理快照口径）。
   *
   * 报的是**质量**（开了拦不拦得住）而非档位；快照缺失/非法时为 undefined 并计入
   * {@link DoctorReport.issues}——不静默输出空报告冒充检查通过。
   */
  readonly injectionSelfCheck: InjectionSelfCheckSummary | undefined;
  /** 插件目录是否可读。 */
  readonly pluginsDirReadable: boolean;
  /** 权限清单是否可读（不存在时视为可读，不计入问题）。 */
  readonly permissionsManifestReadable: boolean;
  /** 不合格项清单。 */
  readonly issues: string[];
}
