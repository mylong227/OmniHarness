/**
 * 定位 POSIX shell（Git for Windows 的 bash / 系统 bash）。
 *
 * 为什么单独成一个类：判分走的是 Python（pytest），**不需要** bash；
 * 但「跑参考解」「Agent 执行 shell 命令」需要，两者对 bash 缺失的容忍度完全不同
 * （前者是能力失败，后者只是少了一条便利通道）。把定位逻辑独立出来，
 * 才能让调用方各自决定「找不到 bash 时怎么办」，而不是被迫接受一个统一策略。
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** bash 定位器（纯静态工具类，无可变状态）。 */
export class BashLocator {
  /** 平台已知的 bash 位置（PATH 扫描兜底）。 */
  private static readonly KNOWN_PATHS: readonly string[] = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    '/bin/bash',
    '/usr/bin/bash',
    '/usr/local/bin/bash',
  ];

  private constructor() {}

  /**
   * 定位 bash。
   *
   * 顺序：`OMNI_BASH` 显式指定 → PATH 扫描 → 平台已知位置。
   * 显式环境变量优先是刻意的：PortableGit 之类**不写 PATH** 的安装方式很常见，
   * 而「明明装了却找不到」应当能靠一个环境变量解决，而不是改代码。
   *
   * @returns 绝对路径；找不到为 null。
   */
  public static locate(): string | null {
    const explicit = process.env['OMNI_BASH'];
    if (explicit !== undefined && explicit.trim() !== '' && existsSync(explicit.trim())) {
      return explicit.trim();
    }
    const names = process.platform === 'win32' ? ['bash.exe'] : ['bash'];
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (dir.trim() === '') {
        continue;
      }
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
    for (const candidate of BashLocator.KNOWN_PATHS) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * 从已知安装位置推断 `MSYS_ROOT`（`<MSYS_ROOT>/usr/bin/bash.exe` / `<MSYS_ROOT>/bin/bash.exe`）。
   *
   * 只在无法真正问 bash 时作兜底：MSYS 的根目录不一定等于安装目录
   * （例如 Git for Windows 的 `bin/bash.exe` 是包装器，真正的 MSYS 根在安装目录本身），
   * 所以权威答案来自 {@link BashLocator.askMsysRoot}。
   *
   * @param bashPath bash 绝对路径。
   * @returns 推断出的根目录；无法推断为 null。
   */
  public static inferMsysRoot(bashPath: string): string | null {
    const lower = bashPath.replace(/\\/g, '/').toLowerCase();
    for (const marker of ['/usr/bin/bash', '/bin/bash', '/usr/bin/sh']) {
      const at = lower.indexOf(marker);
      if (at > 0) {
        return bashPath.replace(/\\/g, '/').slice(0, at).replace(/\//g, '\\');
      }
    }
    const parent = dirname(bashPath);
    return parent === bashPath ? null : parent;
  }
}
