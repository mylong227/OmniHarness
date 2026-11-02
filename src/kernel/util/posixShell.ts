/**
 * POSIX shell 引号工具（只用于把 argv 还原成一条可交给 `sh -c` 的字符串）。
 *
 * 为什么需要：OS 沙箱后端产出的是 argv（`bwrap ... -- /bin/sh -c <command>`），而
 * `ShellProcessRunner` 的契约是「一条命令文本」。把每个 argv 用单引号包起来是最小、
 * 无解释的还原方式；命令内部原有的引号/变量仍由内层 `sh -c` 按原语义处理。
 */
export class PosixShell {
  /**
   * 单引号转义一个参数（内部单引号写成 `'\''`）。
   * @param value 原始参数
   * @returns 可直接拼进 shell 命令的片段
   */
  public static quote(value: string): string {
    return `'${value.replace(/'/gu, `'\\''`)}'`;
  }

  /**
   * 把 argv 拼成一条命令。
   * @param argv 参数数组
   * @returns 空格分隔、逐项单引号的命令文本
   */
  public static command(argv: readonly string[]): string {
    return argv.map((value) => PosixShell.quote(value)).join(' ');
  }
}
