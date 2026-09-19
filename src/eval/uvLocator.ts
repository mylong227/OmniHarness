/**
 * 定位 `uv`（Astral 的 Python 项目管理器）。
 *
 * ## 为什么要单独一个类
 *
 * `NativeExecutor`（SWE-bench 原生后端）把 `uv venv` / `uv pip install` 当作**判定链路的前置设施**：
 * 找不到 uv 就整条链路 fail-closed，只报一句「uv 不可用」。而实际现场（本机实测）是：
 * uv 用官方脚本装在 `%USERPROFILE%\.local\bin\uv.exe`，**默认不在 PATH 上**——
 * 于是「明明装了却判不可用」，基准出数被一个环境变量问题挡死，且报错信息无从下手。
 *
 * 把定位逻辑独立出来（与 `BashLocator` / `ChromeLocator` 同一模式），才能：
 * ① 按「显式指定 → PATH → 平台已知安装位置」的顺序找，而不是只看 PATH；
 * ② 找不到时**如实列出找过哪些位置**（诊断可执行，而不是一句「不可用」）；
 * ③ 让调用方各自决定缺失时的策略（`NativeExecutor` 是 fail-closed 记 envError）。
 *
 * 零第三方依赖；纯静态工具类（无可变状态）。
 */
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { homedir } from 'node:os';

/** uv 定位结果（含「找过哪些位置」，用于可执行诊断）。 */
export interface UvLookup {
  /** uv 可执行文件绝对路径；未找到为 null。 */
  readonly executable: string | null;
  /** 依次尝试过的候选路径（未找到时供报错列出）。 */
  readonly searched: readonly string[];
}

/** 定位选项（默认取进程环境与真实文件系统；测试注入用）。 */
export interface UvLocatorOptions {
  /** 环境变量来源（默认 `process.env`）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 目标平台（默认 `process.platform`）。 */
  readonly platform?: NodeJS.Platform;
  /** 存在性判定（默认 `fs.existsSync`）。 */
  readonly exists?: (path: string) => boolean;
}

/** uv 定位器（纯静态工具类）。 */
export class UvLocator {
  /**
   * 显式指定 uv 绝对路径的环境变量（最高优先级）。
   * 官方安装脚本的默认落点不在 PATH 上，这个变量是「装了就一定能用」的兜底出口。
   */
  public static readonly ENV_KEY = 'OMNI_UV';

  private constructor() {}

  /**
   * 定位 uv。
   *
   * 顺序：`OMNI_UV` 显式指定 → PATH 扫描 → 平台已知安装位置。
   *
   * @param options 定位选项（环境/平台/存在性判定，便于测试注入）。
   * @returns 定位结果；未找到时 `executable === null` 且 `searched` 列出全部候选。
   */
  public static locate(options: UvLocatorOptions = {}): UvLookup {
    const env = options.env ?? process.env;
    const exists = options.exists ?? existsSync;
    const searched = UvLocator.candidates(options);
    const explicit = (env[UvLocator.ENV_KEY] ?? '').trim();
    if (explicit !== '' && exists(explicit)) {
      return { executable: explicit, searched };
    }
    for (const candidate of searched) {
      if (exists(candidate)) {
        return { executable: candidate, searched };
      }
    }
    return { executable: null, searched };
  }

  /**
   * 全部候选路径（按尝试顺序）。
   *
   * @param options 定位选项。
   * @returns 去重后的候选绝对路径列表（已按「显式 → PATH → 已知位置」排序）。
   */
  public static candidates(options: UvLocatorOptions = {}): readonly string[] {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const out: string[] = [];
    UvLocator.push(out, (env[UvLocator.ENV_KEY] ?? '').trim());
    for (const dir of (env['PATH'] ?? '').split(UvLocator.pathDelimiter(platform))) {
      const trimmed = dir.trim();
      if (trimmed === '') continue;
      for (const name of UvLocator.names(platform)) {
        UvLocator.push(out, UvLocator.joinFor(platform, trimmed, name));
      }
    }
    for (const candidate of UvLocator.knownInstalls(platform, env)) {
      UvLocator.push(out, candidate);
    }
    return out;
  }

  /**
   * 目标平台的 PATH 分隔符。
   *
   * **必须按目标平台而非宿主平台取**：本类的 `platform` 选项可注入（单测在 Windows 上验证
   * Linux 候选路径），若用宿主 `path.delimiter`，注入的 `platform: 'linux'` 会被按 `;` 切分，
   * 整条 PATH 被当成一个目录 —— 定位结果随宿主而变，单测也就失去了意义。
   *
   * @param platform 目标平台。
   * @returns ';'（win32）或 ':'（POSIX）。
   */
  private static pathDelimiter(platform: NodeJS.Platform): string {
    return platform === 'win32' ? ';' : ':';
  }

  /**
   * 按目标平台拼接路径（win32 用反斜杠，POSIX 用斜杠）。
   *
   * @param platform 目标平台。
   * @param parts 路径片段。
   * @returns 拼接后的路径。
   */
  private static joinFor(platform: NodeJS.Platform, ...parts: readonly string[]): string {
    return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
  }

  /**
   * 可执行文件名（Windows 带 .exe 后缀）。
   *
   * @param platform 目标平台。
   * @returns 该平台上 uv 的可执行文件名列表。
   */
  private static names(platform: NodeJS.Platform): readonly string[] {
    return platform === 'win32' ? ['uv.exe'] : ['uv'];
  }

  /**
   * 平台已知安装位置（PATH 之外的默认落点）。
   *
   * @param platform 目标平台。
   * @param env 环境变量来源（取 USERPROFILE/HOME 推断家目录）。
   * @returns 候选绝对路径列表。
   */
  private static knownInstalls(
    platform: NodeJS.Platform,
    env: Readonly<Record<string, string | undefined>>,
  ): readonly string[] {
    const home = (env['USERPROFILE'] ?? env['HOME'] ?? homedir()).trim();
    if (platform === 'win32') {
      const localAppData = (env['LOCALAPPDATA'] ?? win32.join(home, 'AppData', 'Local')).trim();
      return [
        win32.join(home, '.local', 'bin', 'uv.exe'),
        win32.join(home, '.cargo', 'bin', 'uv.exe'),
        win32.join(localAppData, 'Programs', 'uv', 'uv.exe'),
        win32.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'uv.exe'),
      ];
    }
    return [
      posix.join(home, '.local', 'bin', 'uv'),
      posix.join(home, '.cargo', 'bin', 'uv'),
      '/usr/local/bin/uv',
      '/usr/bin/uv',
      '/opt/homebrew/bin/uv',
    ];
  }

  /**
   * 去重追加（保留首次出现的位置，即优先级）。
   *
   * @param out 累积中的候选列表（原地修改）。
   * @param candidate 新候选（空串忽略）。
   * @returns 无返回值。
   */
  private static push(out: string[], candidate: string): void {
    if (candidate !== '' && !out.includes(candidate)) {
      out.push(candidate);
    }
  }
}
