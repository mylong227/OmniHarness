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
  public constructor(private readonly options: CliWorkerOptions) {}

  /** 子代理名称。 */
  public get name(): string {
    return this.options.name;
  }

  /** 运行任务。 */
  public async run(request: WorkerRequest): Promise<WorkerResult> {
    const startedAt = Date.now();
    try {
      const output = await this.spawnOutput(request);
      return { ok: true, output, durationMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, output: this.messageOf(error), durationMs: Date.now() - startedAt };
    }
  }

  /** 执行并收集输出。 */
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

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
