import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** 解析器依赖（全部显式注入，便于单测不碰真实文件系统）。 */
export interface PathBinaryResolverOptions {
  /** 待搜索目录（按顺序）。 */
  readonly directories: readonly string[];
  /** 可执行文件候选后缀（Windows 含 `.exe`/`.cmd`，POSIX 为空串）。 */
  readonly suffixes: readonly string[];
  /** 是否存在判定（生产注入 `existsSync`）。 */
  readonly exists: (candidate: string) => boolean;
}

/**
 * 可执行文件定位器：在若干目录里按后缀寻找外部二进制。
 *
 * ## 为什么不直接跑 `which` / `where`
 *
 * ① 那又是一次子进程（为了找一个二进制而先起一个进程，还可能因 PATH 里的
 *    同名脚本而拿到非预期结果）；② 输出格式跨平台不一致；③ 判定「存在」这件事
 *    在本机就是一次 `existsSync`。**存在性用文件系统回答，可用性用一次 `-version` 回答**，
 *    两件事分开才不会出现「找到了但跑不起来」的含糊状态。
 *
 * ## Windows 的后缀必须显式枚举
 *
 * Windows 上 `spawn('ffmpeg')` 不会自动补 `.exe`（Node 只在少数路径上做 PATHEXT 解析），
 * 因此必须自己试 `.exe` → `.cmd` → `.bat` → 无后缀；漏了 `.cmd`/`.bat`
 * 会漏掉 scoop / chocolatey 这类以脚本垫片安装的常见形态。
 */
export class PathBinaryResolver {
  /**
   * @param options 搜索目录、后缀与存在性判定。
   */
  public constructor(private readonly options: PathBinaryResolverOptions) {}

  /**
   * 按当前平台构造默认解析器（生产用）。
   *
   * @param env 环境变量表（缺省用 `process.env`）。
   * @param extraDirectories 追加搜索目录（配置项，优先于 PATH）。
   * @returns 解析器实例。
   */
  public static forEnvironment(
    env: Readonly<Record<string, string | undefined>>,
    extraDirectories: readonly string[],
  ): PathBinaryResolver {
    const windows = process.platform === 'win32';
    const searchPath = env['PATH'] ?? '';
    const fromPath = searchPath.split(delimiter).filter((entry) => entry !== '');
    const extra = extraDirectories.filter((entry) => entry !== '');
    return new PathBinaryResolver({
      directories: [...extra, ...fromPath],
      suffixes: windows ? ['.exe', '.cmd', '.bat', ''] : [''],
      exists: (candidate) => existsSync(candidate),
    });
  }

  /**
   * 定位可执行文件。
   *
   * @param name 可执行文件名（不含后缀，如 `ffmpeg`）；含路径分隔符时按绝对/相对路径直接判定。
   * @returns 可执行文件的绝对或原始路径；找不到时为 `undefined`。
   */
  public resolve(name: string): string | undefined {
    if (name.includes('/') || name.includes('\\') || isAbsolute(name)) {
      return this.options.exists(name) ? name : undefined;
    }
    for (const directory of this.options.directories) {
      for (const suffix of this.options.suffixes) {
        const candidate = join(directory, `${name}${suffix}`);
        if (this.options.exists(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }
}
