import { CliWorker } from './cliWorker.js';

/**
 * @beta
 * dsh（DeepSeek Harness）CLI 适配：为 CliWorker 构造调用参数。
 *
 * - `task(profile)`：一次性任务模式 `dsh --profile <p> "<task>"`，需 dsh 侧已注册模型适配器与凭据。
 * - `inspect(profile)`：配置转储模式，离线可用，用于验证 worker 链路与真实二进制连通性。
 *
 * 无状态构造逻辑以实例方法暴露，由组合根单例 `dshWorker` 统一装配。
 */
export class DshWorker {
  /** 一次性任务 worker。 */
  public task(profile: string): CliWorker {
    return new CliWorker({
      name: `dsh:${profile}`,
      command: 'dsh',
      args: (task) => ['--profile', profile, task],
      shell: needsShell(),
    });
  }

  /** 配置转储 worker（离线可用）。 */
  public inspect(profile: string): CliWorker {
    return new CliWorker({
      name: `dsh-inspect:${profile}`,
      command: 'dsh',
      args: () => ['--profile', profile, '--dump-default-config'],
      shell: needsShell(),
    });
  }
}

/** 组合根单例：dsh worker 构造逻辑的装配点。 */
export const dshWorker = new DshWorker();

/** Windows 上 npm 安装的 dsh 是无扩展名 shell 脚本，不经 shell 会 ENOENT。 */
function needsShell(): boolean {
  return process.platform === 'win32';
}
