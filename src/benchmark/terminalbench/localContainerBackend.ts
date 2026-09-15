/**
 * 本地非隔离容器后端（B2）。
 *
 * 在宿主机临时目录直接执行 argv 命令，**不提供任何隔离**，仅用于适配器开发与单测。
 * 真实 Terminal-Bench 任务应走 DockerContainerBackend（沙箱无 docker，本批未实现运行路径）。
 *
 * 用 execFile 而非 shell，命令以 argv 数组传入，杜绝 shell 注入。
 */
import { execFile } from 'node:child_process';
import type { CommandOutcome, ContainerBackend } from './types.js';

/** 本地非隔离后端（dev / 单测用）。 */
export class LocalContainerBackend implements ContainerBackend {
  /** 后端种类标识（固定 local）。 */
  public readonly kind = 'local' as const;

  private constructor() {}

  /**
   * 创建本地后端实例。
   *
   * @returns 后端实例
   */
  public static create(): LocalContainerBackend {
    return new LocalContainerBackend();
  }

  /**
   * 执行一条 argv 命令。
   *
   * @param cmd 命令与参数（argv 数组）
   * @param workdir 工作目录
   * @returns 退出码与输出
   */
  public runCommand(cmd: readonly string[], workdir: string): Promise<CommandOutcome> {
    return new Promise<CommandOutcome>((resolve) => {
      const file = cmd[0];
      if (file === undefined) {
        resolve({ exitCode: 127, stdout: '', stderr: 'empty command' });
        return;
      }
      const args = cmd.slice(1);
      execFile(file, args, { cwd: workdir, timeout: 120000 }, (err, stdout, stderr) => {
        const exitCode = LocalContainerBackend.normalizeExit(err);
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  /**
   * 把 execFile 回调错误归一为退出码。
   *
   * @param err 回调错误（可能为 null）
   * @returns 退出码（成功 0）
   */
  private static normalizeExit(err: Error | null): number {
    if (err === null) {
      return 0;
    }
    const code = (err as { code?: number | string }).code;
    if (typeof code === 'number') {
      return code;
    }
    // 超时 / 信号等以非零退出码表示失败。
    return 1;
  }
}
