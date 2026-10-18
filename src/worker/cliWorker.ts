import { spawn } from 'node:child_process';
import { ProcessTreeKiller } from '../adapters/tool/shell/processTreeKiller.ts';
import type { Worker, WorkerRequest, WorkerResult } from './worker.ts';
import { WindowsShim } from './windowsShim.ts';

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
  /**
   * 单次任务的时间上限（毫秒，缺省 {@link CliWorker.DEFAULT_TIMEOUT_MS}）。
   *
   * 存在理由（2026-09-26 审计 X3/F3）：原先完全没有超时、也没有取消信号，而 `delegate` 在
   * 工具调度器里是串行屏障 —— 一个挂死的 worker 会**永久阻塞整个回合**，且 abort 后子进程成孤儿。
   */
  readonly timeoutMs?: number;
}

/**
 * @beta
 * 通用 CLI worker：spawn 任意 harness CLI（codex/claude-code/dsh/opencode）。
 */
export class CliWorker implements Worker {
  /** 默认单次任务上限：30 分钟（外部 harness 跑一个真实任务量级的时间）。 */
  public static readonly DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

  /** 子进程输出缓冲上限（字节）：超限即终止并如实报错，避免 OOM。 */
  private static readonly MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

  /**
   * @param options worker 选项：名称、可执行命令与参数构造器（含是否经 shell 执行与超时）
   */
  public constructor(private readonly options: CliWorkerOptions) {}

  /** 子代理名称。 */
  public get name(): string {
    return this.options.name;
  }

  /**
   * 运行任务。
   * @param request 任务描述（任务文本决定命令参数，workspaceRoot 决定子进程工作目录）
   * @returns 成功时携带 CLI 输出与耗时；spawn 失败、超时或退出码非 0 时 `ok:false` 并携带错误消息
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
   *
   * 三条终止路径（超时 / 取消 / 输出超限）都终止**整棵进程树**（见 {@link ProcessTreeKiller}）：
   * 只杀直接子进程会让载荷继续跑并持有 stdout 管道，`close` 永不触发 ⇒ 调用方永久挂起。
   * @param request 任务描述（由选项的 args 构造器展开为命令行参数）
   * @returns 子进程 stdout 与 stderr 的合并文本；退出码非 0 / 超时 / 取消 / spawn 失败时 reject
   */
  private spawnOutput(request: WorkerRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [...this.options.args(request.task, request.workspaceRoot)];
      const spec = this.spawnSpec(args);
      const child = spawn(spec.command, spec.args, {
        cwd: request.workspaceRoot,
        shell: spec.shell,
        env: spec.env,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        ProcessTreeKiller.kill(child);
        fail(`worker ${this.options.name} 超时（${String(this.effectiveTimeoutMs())}ms）`);
      }, this.effectiveTimeoutMs());
      const signal = request.signal;
      const onAbort = (): void => {
        ProcessTreeKiller.kill(child);
        fail(`worker ${this.options.name} 已被取消`);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        spec.cleanup();
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(message));
      };
      const collect = (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > CliWorker.MAX_OUTPUT_BYTES) {
          ProcessTreeKiller.kill(child);
          fail(
            `worker ${this.options.name} 输出超过上限 ${String(CliWorker.MAX_OUTPUT_BYTES)} 字节`,
          );
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (error) => fail(error.message));
      child.on('close', (code) => {
        if (settled) return;
        cleanup();
        if (code === 0) {
          settled = true;
          resolve(Buffer.concat(chunks).toString('utf8'));
        } else {
          settled = true;
          reject(new Error(`worker ${this.options.name} 退出码 ${String(code)}`));
        }
      });
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * 构造实际 spawn 形态。
   *
   * **为什么 Windows 不再 `shell:true`**：`shell:true` 会把 argv 原样拼进 cmd 命令行，
   * 模型可控的 task 里一个 `&` 就能执行任意命令，绕过 shell 工具的审批/沙箱（审查 P0）。
   * 这里改为直接启动 PowerShell，把**参数作为 JSON 数据**从临时文件读入再用 `@workerArgs`
   * splat 传给目标程序——任务文本从不进入命令行解析。POSIX 的 `shell:true` 同样有注入面，
   * 而该选项只是为 Windows 的 npm `.cmd` 垫片存在，故非 Windows 一律关 shell 直接 exec。
   * @param args 目标程序参数（含任务文本）
   * @returns spawn 参数、环境与临时文件清理函数
   */
  private spawnSpec(args: readonly string[]): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    shell: boolean;
    cleanup: () => void;
  } {
    const direct = (): {
      command: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      shell: boolean;
      cleanup: () => void;
    } => ({
      command: this.options.command,
      args: [...args],
      env: process.env,
      shell: false,
      cleanup: (): void => undefined,
    });
    if (this.options.shell !== true || process.platform !== 'win32') {
      return direct();
    }
    // Windows npm CLI 常是 `.cmd` 垫片：解析成 `node <entry.js>` 直接 spawn，任务文本
    // 永远不经过 cmd/`.cmd` 的 `%*` 解析（审查 P0：`&` 注入）。
    const shim = WindowsShim.resolve(this.options.command);
    if (shim !== undefined) {
      return {
        command: shim.command,
        args: [...shim.argsPrefix, ...args],
        env: process.env,
        shell: false,
        cleanup: (): void => undefined,
      };
    }
    if (WindowsShim.isBatch(this.options.command)) {
      throw new Error(
        `无法安全解析 Windows 批处理命令（拒绝把 task 交给 cmd 解析）：${this.options.command}`,
      );
    }
    // 非批处理（.exe / 裸名但 where 没找到）：直接 spawn，失败由 error 事件如实回报。
    return direct();
  }

  /**
   * 生效的超时（毫秒）。
   * @returns 显式配置值；非法（非有限 / ≤0）时回落默认值。
   */
  private effectiveTimeoutMs(): number {
    const configured = this.options.timeoutMs;
    if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
      return CliWorker.DEFAULT_TIMEOUT_MS;
    }
    return configured;
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
