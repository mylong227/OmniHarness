/**
 * 可移植路径：把配置里的路径写成**跨机器成立**的形态，并在启动时展开回本机真实路径。
 *
 * ## 为什么（用户口径，2026-10-06）
 *
 * "保证无论何时何地何种机器都能正确读取为一套配置继续启动"——若配置里写死 `D:\work\新项目`，
 * 换台机器（没有 D 盘 / 用户名不同）就指向幽灵路径。故固定项目允许写成：
 *
 * | 写法 | 展开为 | 典型用途 |
 * | --- | --- | --- |
 * | `~/work/proj` | `<家目录>/work/proj` | 项目在家目录下（最可移植） |
 * | `$HOME/work/proj`、`${HOME}/work/proj` | 同上 | shell 风格写法 |
 * | `%USERPROFILE%\work\proj`、`%HOME%` | 同上 | Windows 环境变量写法 |
 * | `$OMNI_PROJECTS/proj`、`%OMNI_PROJECTS%` | 该环境变量的值 + 后缀 | 团队用环境变量统一指路 |
 * | `work/proj`（相对） | `<家目录>/work/proj` | 相对家目录（配置在用户级，基准即家目录） |
 * | `D:\work\proj`（绝对） | 原样 | 固定磁盘布局 |
 *
 * 反向的 {@link PortablePath.compact} 用于**写回**：把家目录下的绝对路径压成 `~/…`，
 * 使"这台机器记住的项目"在另一台同布局机器上依然成立（不在家目录下的保持原样，绝不臆造）。
 *
 * 设计纪律：展开只做**字符串与文件系统**层面的事，绝不创建目录、绝不猜路径——不存在就是不存在，
 * 由调用方回落并如实说明（见 `CliServerCmds.serveRootOf`）。
 */
import { homedir } from 'node:os';

/**
 * 可移植路径工具（纯静态）：\expand\ 展开模板、\compact\ 压回家目录相对形态。
 */
export class PortablePath {
  /**
   * 展开路径模板为绝对路径。
   * @param raw 原始路径（可能含 `~` / `$VAR` / `${VAR}` / `%VAR%`，也可能是相对路径）。
   * @param home 家目录（缺省 `os.homedir()`；测试注入用）。
   * @param env 环境变量表（缺省 `process.env`；测试注入用）。
   * @returns 展开后的绝对路径；无法展开的变量保持字面量（**不猜**）。
   */
  public static expand(raw: string, home?: string, env?: NodeJS.ProcessEnv): string {
    const text = raw.trim();
    if (text === '') return text;
    const base = home ?? PortablePath.defaultHome();
    const vars = env ?? process.env;
    let out = text;
    // `~` 只在**开头**展开（路径中间的 `~` 是普通字符，不当家目录替换）。
    if (out === '~') return PortablePath.normalize(base);
    if (out.startsWith('~/') || out.startsWith('~\\')) {
      out = `${base}${out.slice(1)}`;
    }
    out = out
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name: string) => vars[name] ?? all)
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, name: string) => vars[name] ?? all)
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, name: string) => vars[name] ?? all);
    // 相对路径以**家目录**为基准（配置住在用户级目录，基准即家目录）；绝对路径原样。
    const normalized = PortablePath.normalize(out);
    return PortablePath.isAbsolutePath(normalized)
      ? normalized
      : PortablePath.normalize(`${base}/${normalized}`);
  }

  /**
   * 压缩为可移植写法：家目录下的绝对路径压成 `~/…`，其余原样返回。
   * @param absolute 绝对路径。
   * @param home 家目录（缺省 `os.homedir()`；测试注入用）。
   * @returns 可移植路径（不在家目录下时与入参相同）。
   */
  public static compact(absolute: string, home?: string): string {
    const base = (home ?? PortablePath.defaultHome()).replace(/[\\/]+$/, '');
    const text = absolute.trim();
    const normalized = PortablePath.normalize(text);
    const baseNormalized = PortablePath.normalize(base);
    if (normalized === baseNormalized) return '~';
    // 大小写不敏感比较：Windows 盘符与用户名都可能大小写不同（实测 `C:\Users\X` vs `c:\users\x`）。
    if (normalized.toLowerCase().startsWith(`${baseNormalized.toLowerCase()}/`)) {
      return `~/${normalized.slice(baseNormalized.length + 1)}`;
    }
    return text;
  }

  /**
   * 家目录（单独包一层，便于测试替换与集中审计）。
   * @returns 当前用户的家目录绝对路径。
   */
  private static defaultHome(): string {
    return homedir();
  }

  /**
   * 统一分隔符为 `/`（本仓其余路径比较一律按 POSIX 分隔口径）。
   * @param value 原始路径。
   * @returns 归一化后的路径（合并重复分隔符、去掉结尾斜杠）。
   */
  private static normalize(value: string): string {
    return (
      value
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/\/$/, '') || value
    );
  }

  /**
   * 是否绝对路径（`/x`、`C:/x`、`//server/share`）。
   * @param value 待判定的路径。
   * @returns 绝对路径为 true。
   */
  private static isAbsolutePath(value: string): boolean {
    return /^([A-Za-z]:)?\//.test(value) || value.startsWith('//');
  }
}
