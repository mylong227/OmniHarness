/**
 * Python 环境制备器：把「任务要的 Python 用户态 + 依赖」现场重建出来。
 *
 * 环境自足落到原生执行就是两件事：
 *  ① **一个可用的解释器**（`env.json` 的 `python` 版本；缺省交给 uv 自选）；
 *  ② **一组装好的包**（`run-tests.sh` 的 `uv pip install …` 与 `env.json` 的 `pip` 参数）。
 *
 * 二者都用宿主已有的 `uv` 完成：`uv venv` 造解释器环境、`uv pip install` 装包。
 * 选 `uv` 而不是别的隔离手段的理由是**效率与依赖面**：它是 Python 生态里现成的
 * 解析器 + 解释器获取器，一次制备的墙钟时间通常在秒级（还有本地解析缓存），
 * 而任何「先起容器再装包」的路径都要先付镜像拉取与层解压的固定成本。
 *
 * **有意的合并**（写出来免得被当成漏接）：上游把「任务环境」与「判分环境」分开
 * （`uv venv .tbench-testing` 只服务于判分），本适配器把两者合并进**同一个** venv。
 * 理由：原生执行里 Agent 与判分器共用同一棵树，若拆两个 venv，
 * 既没有隔离收益（同机同用户），又要多装一遍依赖（每次判分多几十秒）。
 * 合并后判分看到的包是超集，**只会更宽不会更窄**；这一点在报告里以 `warnings` 如实标注。
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CommandRunner } from './types.js';

/**
 * 执行一条命令的接缝（由后端提供，避免制备器自己持有进程能力）。
 *
 * @deprecated 直接使用 {@link CommandRunner}；此别名保留以免既有导入点断裂。
 */
export type ProvisionCommandRunner = CommandRunner;

/** 制备结果。 */
export interface ProvisionedPython {
  /** 解释器绝对路径；失败为 null。 */
  readonly pythonPath: string | null;
  /** 需要注入子进程的环境变量（`VIRTUAL_ENV` / `PATH` / `PYTHONIOENCODING`）。 */
  readonly env: Readonly<Record<string, string>>;
  /** 非致命告警（被跳过的 apt/shell 段、回退行为）。 */
  readonly warnings: readonly string[];
  /** 环境失败原因；成功为 null。 */
  readonly envError: string | null;
}

/** Python 环境制备器。 */
export class PythonEnvironmentProvisioner {
  /** venv 目录名（应用根下）。 */
  public static readonly VENV_DIR = '.venv';

  /** 制备命令的超时（毫秒）：装包可能较慢，给 10 分钟。 */
  public static readonly DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

  /** 宿主 `uv` 的探测位置（PATH 之外）。
   *  这里显式列出本沙箱与本机常见位置，避免「明明装了却找不到」把整轮判成环境失败。 */
  private static readonly KNOWN_UV_PATHS: readonly string[] = [
    join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WinGet', 'Links', 'uv.exe'),
    join(process.env['USERPROFILE'] ?? '', '.local', 'bin', 'uv.exe'),
    join(process.env['USERPROFILE'] ?? '', '.cargo', 'bin', 'uv.exe'),
    join(process.env['HOME'] ?? '', '.local', 'bin', 'uv'),
    join(process.env['HOME'] ?? '', '.cargo', 'bin', 'uv'),
  ];

  /** 已定位的 uv 路径缓存（`undefined` 表示未探测；`null` 表示已探测且未找到）。 */
  private uvCache: string | null | undefined;

  /** 安装超时（毫秒）。 */
  private readonly installTimeoutMs: number;

  /**
   * @param installTimeoutMs 安装命令超时（毫秒，非正数回落默认）。
   */
  public constructor(
    installTimeoutMs: number = PythonEnvironmentProvisioner.DEFAULT_INSTALL_TIMEOUT_MS,
  ) {
    this.installTimeoutMs =
      Number.isFinite(installTimeoutMs) && installTimeoutMs > 0
        ? Math.floor(installTimeoutMs)
        : PythonEnvironmentProvisioner.DEFAULT_INSTALL_TIMEOUT_MS;
  }

  /**
   * 定位宿主 `uv`。
   *
   * @returns 绝对路径；找不到为 null。
   */
  public locateUv(): string | null {
    if (this.uvCache !== undefined) {
      return this.uvCache;
    }
    const explicit = process.env['OMNI_UV'];
    const candidates: string[] = [];
    if (explicit !== undefined && explicit.trim() !== '') {
      candidates.push(explicit.trim());
    }
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (dir.trim() === '') {
        continue;
      }
      candidates.push(join(dir, process.platform === 'win32' ? 'uv.exe' : 'uv'));
    }
    candidates.push(...PythonEnvironmentProvisioner.KNOWN_UV_PATHS);
    for (const candidate of candidates) {
      if (candidate.includes('\u0000') || candidate.trim() === '') {
        continue;
      }
      if (existsSync(candidate)) {
        this.uvCache = candidate;
        return candidate;
      }
    }
    this.uvCache = null;
    return null;
  }

  /**
   * 在应用目录里制备解释器环境并装包。
   *
   * @param appDir 应用目录（venv 建在其下）。
   * @param packages 要安装的 pip 参数（任务依赖 + 判分依赖，已去重；含 `-e`/`-r` 这类旗标）。
   * @param pythonVersion 需要的解释器版本（如 `3.13`）；null 表示交给 uv 自选。
   * @param run 执行命令的接缝。
   * @returns 制备结果（失败走 `envError`，不抛错）。
   */
  public async provision(
    appDir: string,
    packages: readonly string[],
    pythonVersion: string | null,
    run: ProvisionCommandRunner,
  ): Promise<ProvisionedPython> {
    const uv = this.locateUv();
    if (uv === null) {
      return {
        pythonPath: null,
        env: {},
        warnings: [],
        envError: '宿主未找到 uv（安装：https://astral.sh/uv ；或用 OMNI_UV 指定绝对路径）',
      };
    }
    const warnings: string[] = [];
    const venvDir = join(appDir, PythonEnvironmentProvisioner.VENV_DIR);
    const create = await this.createVenv(uv, appDir, pythonVersion, run, warnings);
    if (create !== null) {
      return {
        pythonPath: null,
        env: {},
        warnings,
        envError: `uv venv 失败：${create}`,
      };
    }
    const pythonPath = PythonEnvironmentProvisioner.venvPython(venvDir);
    if (pythonPath === null) {
      return {
        pythonPath: null,
        env: {},
        warnings,
        envError: `uv venv 未产出解释器（期望 ${venvDir} 下有 Scripts/python.exe 或 bin/python）`,
      };
    }
    if (packages.length > 0) {
      const install = await run(
        [uv, 'pip', 'install', '--python', pythonPath, ...packages],
        appDir,
        PythonEnvironmentProvisioner.uvEnv(),
        this.installTimeoutMs,
      );
      if (install.exitCode !== 0) {
        return {
          pythonPath,
          env: PythonEnvironmentProvisioner.childEnv(venvDir),
          warnings,
          envError: `uv pip install 退出码 ${install.exitCode}：${PythonEnvironmentProvisioner.tail(install.stderr || install.stdout)}`,
        };
      }
    }
    warnings.push('判分依赖与任务依赖装入同一 venv（上游分为两处装）；判分可见包为超集，不会更窄');
    return {
      pythonPath,
      env: PythonEnvironmentProvisioner.childEnv(venvDir),
      warnings,
      envError: null,
    };
  }

  /**
   * 建 venv（带解释器版本提示，失败则回退到不指定版本重试一次）。
   *
   * 为什么要回退而不是直接失败：任务声明的是 `3.13` 这类版本，宿主 `uv` 未必能取到
   * （离线、镜像源受限）。回退会让「版本略有差异」的任务仍能跑（判分脚本绝大多数不查小版本），
   * 而**版本信息会写进 warnings**，不会静默假装一致。
   *
   * @param uv uv 路径。
   * @param appDir 应用目录。
   * @param pythonVersion 版本声明。
   * @param run 执行接缝。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 失败时的原因；成功为 null。
   */
  private async createVenv(
    uv: string,
    appDir: string,
    pythonVersion: string | null,
    run: ProvisionCommandRunner,
    warnings: string[],
  ): Promise<string | null> {
    const env = PythonEnvironmentProvisioner.uvEnv();
    if (pythonVersion !== null) {
      const pinned = await run(
        [uv, 'venv', '--python', pythonVersion, PythonEnvironmentProvisioner.VENV_DIR],
        appDir,
        env,
        this.installTimeoutMs,
      );
      if (pinned.exitCode === 0) {
        return null;
      }
      warnings.push(
        `uv venv --python ${pythonVersion} 失败，回退到默认解释器：${PythonEnvironmentProvisioner.tail(pinned.stderr)}`,
      );
    }
    const fallback = await run(
      [uv, 'venv', PythonEnvironmentProvisioner.VENV_DIR],
      appDir,
      env,
      this.installTimeoutMs,
    );
    return fallback.exitCode === 0
      ? null
      : PythonEnvironmentProvisioner.tail(fallback.stderr || fallback.stdout);
  }

  /**
   * 解析 venv 里的解释器路径。
   *
   * @param venvDir venv 目录。
   * @returns 解释器绝对路径；不存在为 null。
   */
  public static venvPython(venvDir: string): string | null {
    const candidates =
      process.platform === 'win32'
        ? [join(venvDir, 'Scripts', 'python.exe')]
        : [join(venvDir, 'bin', 'python3'), join(venvDir, 'bin', 'python')];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * 子进程需要的环境（把 venv 放到 PATH 最前，使 `python` / `pytest` 指向它）。
   *
   * @param venvDir venv 目录。
   * @returns 环境变量表。
   */
  public static childEnv(venvDir: string): Readonly<Record<string, string>> {
    const binDir = process.platform === 'win32' ? join(venvDir, 'Scripts') : join(venvDir, 'bin');
    return {
      VIRTUAL_ENV: venvDir,
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    };
  }

  /**
   * 让 uv 走非交互、免项目发现的环境。
   *
   * @returns 环境变量表。
   */
  private static uvEnv(): Readonly<Record<string, string>> {
    return { UV_NO_PROGRESS: '1', UV_LINK_MODE: 'copy', PYTHONIOENCODING: 'utf-8' };
  }

  /**
   * 取输出尾部若干字符（失败原因总在尾部）。
   *
   * @param text 输出文本。
   * @returns 尾部摘要。
   */
  private static tail(text: string): string {
    const trimmed = text.trim();
    return trimmed.length <= 400 ? trimmed : trimmed.slice(trimmed.length - 400);
  }
}
