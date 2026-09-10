import { accessSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 权限清单文件名（企业管控用，缺省位于工作区根；可选存在，存在时须合法 JSON）。 */
const PERMISSIONS_MANIFEST_NAME = 'omniharness.permissions.json';

/** doctor 选项：工作区根与显式配置文件路径。 */
export interface DoctorOptions {
  /** 工作区根（缺省=process.cwd()）。 */
  readonly workspaceRoot?: string;
  /** 显式配置文件路径（优先于向上查找 omniharness.json）。 */
  readonly configPath?: string;
}

/** 配置检查状态。 */
export interface ConfigStatus {
  readonly exists: boolean;
  readonly valid: boolean;
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
  /** 插件目录是否可读。 */
  readonly pluginsDirReadable: boolean;
  /** 权限清单是否可读（不存在时视为可读，不计入问题）。 */
  readonly permissionsManifestReadable: boolean;
  /** 不合格项清单。 */
  readonly issues: string[];
}

/**
 * 运行环境诊断器：原模块级纯函数归拢为 `DoctorRunner` 静态方法族，
 * 调用点通过同名 `export const` 别名零改动继续引用。
 */
export class DoctorRunner {
  /** 默认插件目录（与 CLI 一致：~/.omniharness/plugins）。 */
  private static defaultPluginsDir(): string {
    return join(homedir(), '.omniharness', 'plugins');
  }

  /** 从目录向上查找 omniharness.json。 */
  private static findConfig(startDir: string): string | undefined {
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

  /** 运行环境诊断（全 node: 内置，零依赖）。 */
  public static runDoctor(opts: DoctorOptions = {}): DoctorReport {
    const issues: string[] = [];
    const workspaceRoot = opts.workspaceRoot ?? process.cwd();

    // ① Node 版本
    const nodeVersion = process.version;

    // ② 配置文件：存在且 JSON 合法
    const config = DoctorRunner.checkConfig(opts.configPath, workspaceRoot, issues);

    // ③ 沙箱后端可用性
    const sandbox = DoctorRunner.checkSandbox(issues);

    // ④ 插件目录可读
    const pluginsDir = DoctorRunner.defaultPluginsDir();
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
        issues.push(`权限清单 JSON 非法: ${manifestPath} (${DoctorRunner.messageOf(error)})`);
      }
    }

    return {
      nodeVersion,
      config,
      sandbox,
      pluginsDirReadable,
      permissionsManifestReadable,
      issues,
    };
  }

  /** 检查配置文件存在性与 JSON 合法性。 */
  private static checkConfig(
    configPath: string | undefined,
    workspaceRoot: string,
    issues: string[],
  ): ConfigStatus {
    const path = configPath ?? DoctorRunner.findConfig(workspaceRoot);
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
      const msg = DoctorRunner.messageOf(error);
      issues.push(`配置文件 JSON 非法: ${path} (${msg})`);
      return { exists: true, valid: false, error: msg };
    }
  }

  /** 探测沙箱后端：bwrap / sandbox-exec / Windows RestrictedToken。 */
  private static checkSandbox(issues: string[]): SandboxStatus {
    const bwrap = DoctorRunner.detectCommand('bwrap');
    const sandboxExec = DoctorRunner.detectCommand('sandbox-exec');
    // 不再仅用 process.platform 误报：RestrictedToken 真实可用需进程具备创建受限令牌的特权
    // （非管理员 Windows 上 Rust 侧 available() 实测为 false）。此处以提权探测为代理，与运行时一致。
    const restrictedToken = DoctorRunner.isElevated();
    if (!bwrap && !sandboxExec && !restrictedToken) {
      issues.push('未检测到可用沙箱后端（bwrap / sandbox-exec / Windows RestrictedToken 均不可用）');
    }
    return { bwrap, sandboxExec, restrictedToken };
  }

  /**
   * 进程是否已提权（仅 Windows 有意义）。
   * 代理探测：仅管理员可成功执行 `net session`（非管理员返回「Access is denied」并以非零码退出）。
   * 这是 Rust 侧 `RestrictedTokenSandbox::available()` 运行时真实探测的轻量 TS 代理，
   * 用于让 doctor 诚实报告 OS 级沙箱后端是否真的可用，而非仅凭平台瞎报。
   * @param runProbe 可注入的探测函数（默认执行 `net session`），便于单测。
   */
  public static isElevated(runProbe: () => void = DoctorRunner.defaultElevationProbe): boolean {
    if (process.platform !== 'win32') return false;
    try {
      runProbe();
      return true;
    } catch {
      return false;
    }
  }

  /** 默认提权探测：非管理员 Windows 上 `net session` 以 Access Denied 非零码退出 → 抛错。 */
  private static defaultElevationProbe(): void {
    execFileSync('net', ['session'], { stdio: 'ignore', timeout: 5000 });
  }

  /** 用 which 探测命令是否存在（catch 视为不可用，零依赖）。 */
  private static detectCommand(command: string): boolean {
    try {
      execFileSync('which', [command], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** 提取错误消息文本。 */
  private static messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** 把报告以人类可读摘要打到 stdout。 */
  public static printDoctor(report: DoctorReport): void {
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

// ---- 门面兼容：保留原导出名 ----
export const runDoctor = DoctorRunner.runDoctor;
export const isElevated = DoctorRunner.isElevated;
export const printDoctor = DoctorRunner.printDoctor;
