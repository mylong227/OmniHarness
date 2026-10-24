/** Harness 侧车进程管理：spawn / 就绪 / 健康 / 优雅停 / 强杀兜底。 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DesktopLogger } from './logger.ts';
import type { ReadyInfo } from './lib/ready.ts';
import { assertReadyz, waitForExit, waitForReadyFile } from './lib/ready.ts';

/** 侧车状态。 */
export type HarnessState = 'idle' | 'starting' | 'ready' | 'stopping' | 'crashed';

/** 启动参数。 */
export interface HarnessOptions {
  /** 工作区绝对路径。 */
  readonly workspace: string;
  /** CLI 入口。 */
  readonly entry: string;
  /** node 可执行文件/命令。 */
  readonly node: string;
  /** 就绪文件目录。 */
  readonly runDir: string;
  /** 日志器。 */
  readonly logger: DesktopLogger;
}

/** 就绪句柄。 */
export interface HarnessHandle {
  /** 实际端口。 */
  readonly port: number;
  /** 本次 Token（仅内存）。 */
  readonly token: string;
  /** 工作区。 */
  readonly workspace: string;
}

/**
 * 构造 Harness 子进程环境。
 *
 * 关键：侧车是独立 `node.exe`，会读 `NODE_OPTIONS` 等；即使 Electron 关了 fuse 也管不到它。
 * 因此这里显式清洗危险变量，并只注入受控的 `OMNI_*`。
 * @param base 父进程环境。
 * @param extra 受控变量。
 * @returns 清洗后的环境。
 */
export function buildHarnessEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ASAR',
  ]) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/** Harness 侧车管理器。 */
export class HarnessSupervisor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private state: HarnessState = 'idle';
  private handle: HarnessHandle | undefined;
  private readyPath: string | undefined;

  /**
   * @param options 启动参数。
   */
  public constructor(private readonly options: HarnessOptions) {
    super();
  }

  /**
   * 当前状态。
   * @returns 状态。
   */
  public getState(): HarnessState {
    return this.state;
  }

  /**
   * 当前就绪句柄。
   * @returns 句柄；未就绪为 undefined。
   */
  public current(): HarnessHandle | undefined {
    return this.handle;
  }

  /**
   * 启动并等待就绪。
   * @returns 就绪句柄。
   */
  public async start(): Promise<HarnessHandle> {
    if (this.state === 'ready' && this.handle !== undefined) return this.handle;
    if (this.child !== undefined) await this.stop();
    if (!existsSync(this.options.entry)) {
      throw new Error(`Harness 入口不存在：${this.options.entry}（先运行 npm run build）`);
    }

    this.state = 'starting';
    const token = randomBytes(32).toString('hex');
    mkdirSync(this.options.runDir, { recursive: true });
    const readyPath = join(
      this.options.runDir,
      `harness-${String(process.pid)}-${String(Date.now())}.json`,
    );
    this.readyPath = readyPath;
    const env = buildHarnessEnv(process.env, {
      OMNI_SERVE_TOKEN: token,
      OMNI_READY_FILE: readyPath,
      OMNI_CONTROL_STDIO: '1',
      OMNI_NO_SERVE_INSTANCE: '1',
      OMNI_NO_UI_URL: '1',
      OMNI_EMBEDDING_CACHE_DIR: join(this.options.runDir, '..', 'models'),
      OMNI_VEC_CACHE: join(this.options.runDir, '..', 'vec-cache'),
      NO_COLOR: '1',
    });

    this.options.logger.write(
      'main',
      `spawn harness: ${this.options.node} ${this.options.entry} (workspace=${this.options.workspace})`,
    );
    const child = spawn(
      this.options.node,
      [this.options.entry, 'serve', '--port', '0', '--workspace', this.options.workspace],
      {
        cwd: this.options.workspace,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.pipe(child);

    child.once('error', (error) => {
      this.options.logger.write('main', `harness spawn error: ${error.message}`);
      if (this.state === 'starting') {
        this.state = 'crashed';
        this.emit('crashed', error);
      }
    });
    child.once('exit', (code, signal) => {
      const phase = this.state;
      const unexpected = phase === 'ready';
      this.options.logger.write(
        'main',
        `harness exit code=${String(code)} signal=${String(signal)} phase=${phase}`,
      );
      this.child = undefined;
      this.handle = undefined;
      if (phase === 'starting') {
        // 启动失败由 start() 的 waitForReadyFile 抛错统一处理，避免和 crash 面板重复弹窗。
        this.state = 'crashed';
        return;
      }
      if (unexpected) {
        this.state = 'crashed';
        this.emit('crashed', new Error(`Harness 意外退出（code=${String(code)}）`));
      } else if (phase === 'stopping') {
        this.state = 'idle';
      }
    });

    try {
      const ready: ReadyInfo = await waitForReadyFile(readyPath, child, 30_000);
      await assertReadyz(ready.port, token);
      this.handle = { port: ready.port, token, workspace: ready.workspace };
      this.state = 'ready';
      this.options.logger.write('main', `harness ready on 127.0.0.1:${String(ready.port)}`);
      return this.handle;
    } catch (error) {
      this.options.logger.write(
        'main',
        `harness start failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.state = 'crashed';
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  /**
   * 优雅停止；10s 后强杀，再 2s 后树杀（Windows）。
   * @returns 无返回值。
   */
  public async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      this.state = 'idle';
      this.cleanupReady();
      return;
    }
    this.state = 'stopping';
    this.options.logger.write('main', 'stopping harness (stdin shutdown)');
    try {
      child.stdin.write('{"type":"shutdown"}\n');
      child.stdin.end();
    } catch {
      // 管道可能已断；走强杀兜底。
    }
    if (!(await waitForExit(child, 10_000))) {
      this.options.logger.write('main', 'harness did not exit in 10s; killing');
      child.kill();
      if (!(await waitForExit(child, 2_000))) {
        this.options.logger.write('main', 'harness still alive; taskkill tree');
        HarnessSupervisor.killTree(child.pid);
      }
    }
    this.child = undefined;
    this.handle = undefined;
    this.state = 'idle';
    this.cleanupReady();
  }

  /**
   * 转发 stdout/stderr 到日志（逐行）。
   * @param child 子进程。
   * @returns 无返回值。
   */
  private pipe(child: ChildProcessWithoutNullStreams): void {
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this.options.logger.write('harness', line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => this.options.logger.write('harness', line));
  }

  /**
   * 删除本次就绪文件。
   * @returns 无返回值。
   */
  private cleanupReady(): void {
    if (this.readyPath !== undefined) {
      rmSync(this.readyPath, { force: true });
      this.readyPath = undefined;
    }
  }

  /**
   * Windows 进程树强杀；非 Windows 只杀本进程。
   * @param pid 进程 id。
   * @returns 无返回值。
   */
  private static killTree(pid: number | undefined): void {
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出。
    }
  }
}
