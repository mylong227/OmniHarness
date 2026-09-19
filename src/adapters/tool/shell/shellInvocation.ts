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
   * @param platform 平台名（默认 `process.platform`；显式传入是为了让 argv 构造可在
   *   任意平台上被确定性单测，见 {@link PtyCapability.argvOf}）。
   * @returns argv 数组（命令文本始终作为**单个**参数传递，不再经历二次拼接）。
   */
  public static args(
    shell: string,
    command: string,
    platform: string = process.platform,
  ): string[] {
    if (platform === 'win32' || /(^|[\\/])cmd(\.exe)?$/i.test(shell)) {
      return ['/d', '/s', '/c', command];
    }
    return ['-c', command];
  }

  /**
   * 构造「分配伪终端（PTY）执行命令」的调用形态：用 GNU `script` 包一层，
   * 让 TUI 程序（vim / htop / 交互式安装器）拿到真终端而非管道，行为才正确。
   *
   * 命令整体用单引号转义后作为 `bash -c '<command>'` 的参数——**不经历二次拼接**
   * （否则命令里的引号会重新被 shell 解析，构成注入面）。转义采用标准 `'\''` 写法。
   *
   * 本方法只管**构造**，不管可用性判定；「本机能否交互」由 {@link PtyCapability} 分级
   * （`script` 可用 ⇒ 本形态；父进程有 TTY 而无 `script` ⇒ `stdio: 'inherit'` 直通；
   * 都没有 ⇒ fail-closed）。
   *
   * @param command 命令文本。
   * @param platform 平台名（默认 `process.platform`；Windows 原生无 pseudo-terminal，恒不可用）。
   * @param shell shell 可执行文件（默认 {@link ShellInvocation.path}；测试可显式传入）。
   * @returns `{ bin, args }`：`spawn(bin, args)` 即得到带 PTY 的执行。
   * @throws 当前平台不可用（Windows 原生无 pseudo-terminal）时抛出可读错误，由上层 fail-closed。
   */
  public static ptyCommand(
    command: string,
    platform: string = process.platform,
    shell: string = ShellInvocation.path(),
  ): { bin: string; args: string[] } {
    if (platform === 'win32') {
      throw new Error(
        'PTY（tty）在当前平台不可用：Windows 原生无 pseudo-terminal，需 node-pty / conpty；' +
          '请改用非交互命令（或在该命令前加 `winpty`）；' +
          '若父进程本身跑在真终端里，交互式 TUI 请改用 shell_interactive（以 stdio: inherit 继承该终端）',
      );
    }
    const quoted = `'${command.replace(/'/g, "'\\''")}'`;
    const inner = `${shell} -c ${quoted}`;
    return { bin: 'script', args: ['-qec', inner, '/dev/null'] };
  }
}
