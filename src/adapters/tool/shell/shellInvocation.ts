/**
 * shell 调用形态的唯一来源：`shell` 工具与后台作业注册表**共用**同一套
 * 「用哪个解释器、怎么把命令文本传进去」的判定，避免两份实现各自漂移。
 *
 * 为什么要抽出来：后台作业与前台执行必须对同一条命令给出**同一种**解释方式，
 * 否则「前台能跑、后台跑不了」会变成一类无法归因的怪现象。
 */

/**
 * shell 调用形态（无状态，纯静态）。
 */
export class ShellInvocation {
  /**
   * 解析 shell 可执行文件位置：Windows 取 `ComSpec`，类 Unix 取 `SHELL`，均有约定兜底。
   *
   * @returns shell 可执行文件（可由 PATH 解析）。
   */
  public static path(): string {
    if (process.platform === 'win32') {
      const comspec = process.env['ComSpec'];
      return comspec !== undefined && comspec !== '' ? comspec : 'cmd.exe';
    }
    const shell = process.env['SHELL'];
    return shell !== undefined && shell !== '' ? shell : '/bin/sh';
  }

  /**
   * 构造「以解释器执行一段命令文本」的 argv。
   *
   * @param shell shell 可执行文件（仅用于判断是否 Windows 风格）。
   * @param command 命令文本。
   * @returns argv 数组（命令文本始终作为**单个**参数传递，不再经历二次拼接）。
   */
  public static args(shell: string, command: string): string[] {
    if (process.platform === 'win32' || /(^|[\\/])cmd(\.exe)?$/i.test(shell)) {
      return ['/d', '/s', '/c', command];
    }
    return ['-c', command];
  }
}
