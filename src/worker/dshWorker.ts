import { CliWorker } from './cliWorker.js';

/**
 * @beta
 * dsh（DeepSeek Harness）CLI 适配：为 CliWorker 构造调用参数。
 *
 * - `task(profile)`：一次性任务模式 `dsh --profile <p> "<task>"`，需 dsh 侧已注册模型适配器与凭据。
 * - `inspect(profile)`：配置转储模式，离线可用，用于验证 worker 链路与真实二进制连通性。
 */
export class DshWorker {
  /** 一次性任务 worker。 */
  public static task(profile: string): CliWorker {
    return new CliWorker({
      name: `dsh:${profile}`,
      command: 'dsh',
      args: (task) => ['--profile', profile, task],
      shell: needsShell(),
    });
  }

  /** 配置转储 worker（离线可用）。 */
  public static inspect(profile: string): CliWorker {
    return new CliWorker({
      name: `dsh-inspect:${profile}`,
      command: 'dsh',
      args: () => ['--profile', profile, '--dump-default-config'],
      shell: needsShell(),
    });
  }
}

/** Windows 上 npm 安装的 dsh 是无扩展名 shell 脚本，不经 shell 会 ENOENT。 */
function needsShell(): boolean {
  return process.platform === 'win32';
}
