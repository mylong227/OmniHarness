import { accessSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SandboxCapabilityTable } from '../adapters/sandbox/sandboxCapabilityTable.js';
import type { SandboxCapabilityEntry } from '../adapters/sandbox/sandboxCapabilityTable.js';

/** 权限清单文件名（企业管控用，缺省位于工作区根；可选存在，存在时须合法 JSON）。 */
const PERMISSIONS_MANIFEST_NAME = 'omniharness.permissions.json';

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
  /** 插件目录是否可读。 */
  readonly pluginsDirReadable: boolean;
  /** 权限清单是否可读（不存在时视为可读，不计入问题）。 */
  readonly permissionsManifestReadable: boolean;
  /** 不合格项清单。 */
  readonly issues: string[];
}

/**
 * 运行环境诊断器：原是模块级纯函数，后归拢为 `DoctorRunner` 静态方法族，
 * 现改为实例方法以消除 `static`（无隐式状态，同一实例可并发复用）。
 * 对外门面函数（`runDoctor` / `isElevated` / `printDoctor`）签名保持不变，调用点零改动。
 */
export class DoctorRunner {
  /**
   * 默认插件目录（与 CLI 一致：~/.omniharness/plugins）。
   * @returns 插件目录绝对路径。
   */
  private defaultPluginsDir(): string {
    return join(homedir(), '.omniharness', 'plugins');
  }

  /**
   * 从目录向上查找 omniharness.json。
   * @param startDir 查找起点目录。
   * @returns 找到的配置文件路径；到文件系统根仍未找到时返回 undefined。
   */
  private findConfig(startDir: string): string | undefined {
    let current = startDir;
    while (true) {
      const candidate = join(current, 'omniharness.json');
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  /**
   * 运行环境诊断（全 node: 内置，零依赖）。
   * @param opts 诊断选项（工作区根与显式配置路径，缺省取 process.cwd()）。
   * @returns 汇总 Node 版本、配置、沙箱、插件目录、权限清单的诊断报告。
   */
  public runDoctor(opts: DoctorOptions = {}): DoctorReport {
    const issues: string[] = [];
    const workspaceRoot = opts.workspaceRoot ?? process.cwd();

    // ① Node 版本
    const nodeVersion = process.version;

    // ② 配置文件：存在且 JSON 合法
    const config = this.checkConfig(opts.configPath, workspaceRoot, issues);

    // ③ 沙箱后端可用性
    const sandbox = this.checkSandbox(issues);

    // ③b OS 沙箱能力自述表（2026-09-19 全量收口）：把「哪些后端能在本机真跑、依据是什么」
    // 变成可复现的诊断输出——此前这类信息只散落在文档里，且「实现存在但无真机证据」不可见。
    const sandboxCapabilities = SandboxCapabilityTable.describe(workspaceRoot, {
      elevated: sandbox.restrictedToken,
    });

    // ④ 插件目录可读
    const pluginsDir = this.defaultPluginsDir();
    let pluginsDirReadable = false;
    try {
      accessSync(pluginsDir);
      pluginsDirReadable = true;
    } catch {
      issues.push(`插件目录不可读或不存在: ${pluginsDir}`);
    }

    // ⑤ 权限清单可读（仅当存在时校验）
    const manifestPath = join(workspaceRoot, PERMISSIONS_MANIFEST_NAME);
    let permissionsManifestReadable = true;
    if (existsSync(manifestPath)) {
      try {
        JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (error) {
        permissionsManifestReadable = false;
        issues.push(`权限清单 JSON 非法: ${manifestPath} (${this.messageOf(error)})`);
      }
    }

    return {
      nodeVersion,
      config,
      sandbox,
      sandboxCapabilities,
      pluginsDirReadable,
      permissionsManifestReadable,
      issues,
    };
  }

  /**
   * 检查配置文件存在性与 JSON 合法性。
   * @param configPath 显式配置路径（优先）；undefined 时向上查找。
   * @param workspaceRoot 向上查找的起点工作区根。
   * @param issues 累积问题的清单（本方法向其追加发现的问题）。
   * @returns 配置检查状态（exists / valid / error）。
   */
  private checkConfig(
    configPath: string | undefined,
    workspaceRoot: string,
    issues: string[],
  ): ConfigStatus {
    const path = configPath ?? this.findConfig(workspaceRoot);
    if (path === undefined || !existsSync(path)) {
      issues.push(
        `未找到 omniharness.json 配置文件（可使用 omniharness.json.example 或 init-config 生成）`,
      );
      return { exists: false, valid: false };
    }
    try {
      JSON.parse(readFileSync(path, 'utf8'));
      return { exists: true, valid: true };
    } catch (error) {
      const msg = this.messageOf(error);
      issues.push(`配置文件 JSON 非法: ${path} (${msg})`);
      return { exists: true, valid: false, error: msg };
    }
  }

  /**
   * 探测沙箱后端：bwrap / sandbox-exec / Windows RestrictedToken。
   * @param issues 累积问题的清单（三者均不可用时追加一条）。
   * @returns 各沙箱后端的可用性状态。
   */
  private checkSandbox(issues: string[]): SandboxStatus {
    const bwrap = this.detectCommand('bwrap');
    const sandboxExec = this.detectCommand('sandbox-exec');
    // 不再仅用 process.platform 误报：RestrictedToken 真实可用需进程具备创建受限令牌的特权
    // （非管理员 Windows 上 Rust 侧 available() 实测为 false）。此处以提权探测为代理，与运行时一致。
    const restrictedToken = this.isElevated();
    if (!bwrap && !sandboxExec && !restrictedToken) {
      issues.push(
        '未检测到可用沙箱后端（bwrap / sandbox-exec / Windows RestrictedToken 均不可用）',
      );
    }
    return { bwrap, sandboxExec, restrictedToken };
  }

  /**
   * 进程是否已提权（仅 Windows 有意义）。
   * 代理探测：仅管理员可成功执行 `net session`（非管理员返回「Access is denied」并以非零码退出）。
   * 这是 Rust 侧 `RestrictedTokenSandbox::available()` 运行时真实探测的轻量 TS 代理，
   * 用于让 doctor 诚实报告 OS 级沙箱后端是否真的可用，而非仅凭平台瞎报。
   * @param runProbe 可注入的探测函数（默认执行 `net session`），便于单测。
   * @returns 非 Windows 恒为 false；Windows 上探测成功（已提权）为 true。
   */
  public isElevated(runProbe: () => void = () => this.defaultElevationProbe()): boolean {
    if (process.platform !== 'win32') return false;
    try {
      runProbe();
      return true;
    } catch {
      return false;
    }
  }

  /** 默认提权探测：非管理员 Windows 上 `net session` 以 Access Denied 非零码退出 → 抛错。
   * @returns 无返回值。
   */
  private defaultElevationProbe(): void {
    execFileSync('net', ['session'], { stdio: 'ignore', timeout: 5000 });
  }

  /**
   * 用 which 探测命令是否存在（catch 视为不可用，零依赖）。
   * @param command 待探测的命令名。
   * @returns 命令在 PATH 中可找到为 true，否则 false。
   */
  private detectCommand(command: string): boolean {
    try {
      execFileSync('which', [command], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 提取错误消息文本。
   * @param error 任意抛出值。
   * @returns Error 实例取 message，其余取 String(error)。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 把报告以人类可读摘要打到 stdout。
   * @param report 待输出的诊断报告。
   
 * @returns 无返回值。
*/
  public printDoctor(report: DoctorReport): void {
    const lines: string[] = [];
    lines.push('OmniHarness 诊断报告');
    lines.push('--------------------------------------------------');
    lines.push(`  Node 版本        : ${report.nodeVersion}`);
    lines.push(
      `  配置文件          : ${report.config.exists ? '存在' : '缺失'} / ${report.config.valid ? '合法' : '非法'}` +
        (report.config.error !== undefined ? ` (${report.config.error})` : ''),
    );
    lines.push(
      `  沙箱后端          : bwrap=${report.sandbox.bwrap ? 'OK' : 'NO'} ` +
        `sandbox-exec=${report.sandbox.sandboxExec ? 'OK' : 'NO'} ` +
        `restrictedToken=${report.sandbox.restrictedToken ? 'OK' : 'NO'}`,
    );
    lines.push(`  插件目录可读      : ${report.pluginsDirReadable ? '是' : '否'}`);
    lines.push(`  权限清单可读      : ${report.permissionsManifestReadable ? '是' : '否'}`);
    lines.push('');
    // OS 沙箱能力自述表：区分「实现存在」与「本机真能跑」，避免把无证据当可用。
    lines.push(SandboxCapabilityTable.format(report.sandboxCapabilities));
    lines.push('');
    if (report.issues.length === 0) {
      lines.push('[OK] 未发现健康问题');
    } else {
      lines.push(`[WARN] 发现 ${report.issues.length} 项问题:`);
      for (const issue of report.issues) {
        lines.push(`  - ${issue}`);
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const doctorRunner = new DoctorRunner();

/**
 * 运行环境诊断（门面：委托默认诊断器实例）。
 * @param opts 诊断选项（缺省取 process.cwd()）。
 * @returns 汇总诊断报告。
 */
export function runDoctor(opts: DoctorOptions = {}): DoctorReport {
  return doctorRunner.runDoctor(opts);
}

/**
 * 进程是否已提权（仅 Windows 有意义；门面：委托默认诊断器实例）。
 * @param runProbe 可注入的探测函数（缺省执行 `net session`）。
 * @returns 非 Windows 恒为 false；Windows 已提权为 true。
 */
export function isElevated(runProbe?: () => void): boolean {
  return doctorRunner.isElevated(runProbe);
}

/**
 * 把报告以人类可读摘要打到 stdout（门面：委托默认诊断器实例）。
 * @param report 待输出的诊断报告。
 */
export function printDoctor(report: DoctorReport): void {
  doctorRunner.printDoctor(report);
}
