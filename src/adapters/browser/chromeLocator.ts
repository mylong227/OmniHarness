/**
 * Chromium 可执行文件定位器。
 *
 * 为什么要单独一个类：`browser_screenshot` 在本机能不能用，**完全取决于找不找得到浏览器**。
 * 「找不到」和「截图为空」是两种完全不同的失败，前者必须给出**可执行**的补救
 * （`CHROME_PATH=...`），后者才是真 bug。故定位逻辑独立成类、返回结构化结果，
 * 且把候选清单做成**可注入**的——测试不该依赖本机恰好装了 Chrome。
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** 定位结果：命中给路径，未命中给「查过哪里」。 */
export interface ChromeLookup {
  /** 命中的可执行文件绝对路径；未命中为 null。 */
  readonly executable: string | null;
  /** 依序尝试过的候选（未命中时用于给出可执行的原因，命中时用于自证优先级）。 */
  readonly searched: readonly string[];
}

/** 定位选项（全部可注入，便于测试脱离本机环境）。 */
export interface ChromeLocatorOptions {
  /** 显式指定的可执行文件（最高优先级）。 */
  readonly explicit?: string | undefined;
  /** 环境变量表（默认 `process.env`）。 */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** 平台名（默认 `process.platform`）。 */
  readonly platform?: string | undefined;
  /** 存在性判定（默认 `fs.existsSync`，测试可注入）。 */
  readonly exists?: ((path: string) => boolean) | undefined;
  /** `PATH` 上的命令名（POSIX 用，默认见 {@link ChromeLocator.PATH_COMMANDS}）。 */
  readonly pathCommands?: readonly string[] | undefined;
}

/**
 * Chromium 可执行文件定位器（纯静态、无状态）。
 */
export class ChromeLocator {
  /** 环境变量名：本仓既有约定 `OMNI_CHROME_PATH` 优先，其次通用的 `CHROME_PATH`。 */
  public static readonly ENV_KEYS = ['OMNI_CHROME_PATH', 'CHROME_PATH'] as const;

  /** POSIX 下在 `PATH` 里按名查找的命令（Windows 上不看 `PATH`——那里 Chrome 从不入 `PATH`）。 */
  public static readonly PATH_COMMANDS = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
  ] as const;

  private constructor() {}

  /**
   * 按优先级给出全部候选路径（不判存在性，便于测试与排错）。
   *
   * 顺序即优先级：显式指定 → 环境变量 → 平台已知安装位置 → `PATH` 扫描。
   *
   * @param options 定位选项（可注入）。
   * @returns 去重后的候选路径列表。
   */
  public static candidates(options: ChromeLocatorOptions = {}): readonly string[] {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const out: string[] = [];

    ChromeLocator.push(out, options.explicit ?? '');
    for (const key of ChromeLocator.ENV_KEYS) {
      ChromeLocator.push(out, env[key] ?? '');
    }
    for (const path of ChromeLocator.knownInstalls(platform, env)) {
      ChromeLocator.push(out, path);
    }
    for (const path of ChromeLocator.pathScan(platform, env, options.pathCommands)) {
      ChromeLocator.push(out, path);
    }
    return out;
  }

  /**
   * 定位一个可用的 Chromium 可执行文件。
   *
   * @param options 定位选项（可注入）。
   * @returns 结构化结果：命中给路径与已查清单，未命中给完整已查清单。
   */
  public static locate(options: ChromeLocatorOptions = {}): ChromeLookup {
    const exists = options.exists ?? existsSync;
    const searched = ChromeLocator.candidates(options);
    for (const candidate of searched) {
      if (exists(candidate)) {
        return { executable: candidate, searched };
      }
    }
    return { executable: null, searched };
  }

  /**
   * 平台已知安装位置。
   *
   * @param platform 平台名（`win32` / `darwin` / 其它视为 Linux）。
   * @param env 环境变量表（Windows 上用于拼 `LOCALAPPDATA` / `PROGRAMFILES`）。
   * @returns 绝对路径候选列表。
   */
  private static knownInstalls(
    platform: string,
    env: Readonly<Record<string, string | undefined>>,
  ): readonly string[] {
    if (platform === 'win32') {
      const local = env['LOCALAPPDATA'] ?? '';
      const pf = env['PROGRAMFILES'] ?? 'C:\\Program Files';
      const pf86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
      return [
        join(pf, 'Google/Chrome/Application/chrome.exe'),
        join(pf86, 'Google/Chrome/Application/chrome.exe'),
        local === '' ? '' : join(local, 'Google/Chrome/Application/chrome.exe'),
        join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
        join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      ].filter((path) => path !== '');
    }
    if (platform === 'darwin') {
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
    }
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ];
  }

  /**
   * 在 `PATH` 上按命令名解析（纯 Node，不 spawn `which`——Windows 上根本没有 `which`）。
   *
   * @param platform 平台名（`win32` 直接返回空）。
   * @param env 环境变量表（读 `PATH`）。
   * @param commands 命令名列表（缺省用 {@link ChromeLocator.PATH_COMMANDS}）。
   * @returns 候选绝对路径列表。
   */
  private static pathScan(
    platform: string,
    env: Readonly<Record<string, string | undefined>>,
    commands: readonly string[] | undefined,
  ): readonly string[] {
    if (platform === 'win32') {
      return [];
    }
    const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
    const names = commands ?? ChromeLocator.PATH_COMMANDS;
    const out: string[] = [];
    for (const dir of dirs) {
      for (const name of names) {
        out.push(join(dir, name));
      }
    }
    return out;
  }

  /**
   * 追加非空且未出现过的候选（去重保持首次出现的位置，即优先级）。
   *
   * @param out 收集数组。
   * @param value 候选路径。
   * @returns 无返回值。
   */
  private static push(out: string[], value: string): void {
    const trimmed = value.trim();
    if (trimmed !== '' && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
}
