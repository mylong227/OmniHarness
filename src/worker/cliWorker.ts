import { spawn } from 'node:child_process';
import type { Worker, WorkerRequest, WorkerResult } from './worker.js';

/**
 * @beta
 * CLI worker 选项。
 */
export interface CliWorkerOptions {
  readonly name: string;
  readonly command: string;
  readonly args: (task: string, workspaceRoot: string) => readonly string[];
  /**
   * 是否经系统 shell 执行。
   * Windows 上 npm 安装的 CLI 常为无扩展名 shell 脚本（如 dsh），
   * 不经 shell 会 ENOENT，此类 worker 需置为 true。
   */
  readonly shell?: boolean;
}

/**
 * @beta
 * 通用 CLI worker：spawn 任意 harness CLI（codex/claude-code/dsh/opencode）。
 */
export class CliWorker implements Worker {
  /**
   * @param options worker 选项：名称、可执行命令与参数构造器（含是否经 shell 执行）
   */
  public constructor(private readonly options: CliWorkerOptions) {}

  /** 子代理名称。 */
  public get name(): string {
    return this.options.name;
  }

  /**
   * 运行任务。
   * @param request 任务描述（任务文本决定命令参数，workspaceRoot 决定子进程工作目录）
   * @returns 成功时携带 CLI 输出与耗时；spawn 失败或退出码非 0 时 `ok:false` 并携带错误消息
   */
  public async run(request: WorkerRequest): Promise<WorkerResult> {
    const startedAt = Date.now();
    try {
      const output = await this.spawnOutput(request);
      return { ok: true, output, durationMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, output: this.messageOf(error), durationMs: Date.now() - startedAt };
    }
  }

  /**
   * 执行并收集输出。
   * @param request 任务描述（由选项的 args 构造器展开为命令行参数）
   * @returns 子进程 stdout 与 stderr 的合并文本；退出码非 0 或 spawn 失败时 reject
   */
  private spawnOutput(request: WorkerRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [...this.options.args(request.task, request.workspaceRoot)];
      const child = spawn(this.options.command, args, {
        cwd: request.workspaceRoot,
        shell: this.options.shell === true,
      });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } else {
          reject(new Error(`worker ${this.options.name} 退出码 ${code}`));
        }
      });
    });
  }

  /**
   * 提取错误消息。
   * @param error 捕获到的抛出值（可能是任意类型）
   * @returns Error 实例取 message，其余值 String 化
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
