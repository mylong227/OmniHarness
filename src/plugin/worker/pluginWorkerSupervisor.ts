import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ProcessTreeKiller } from '../../adapters/tool/shell/processTreeKiller.ts';
import { log } from '../../util/logger.ts';
import type { ToolCall } from '../../ports/tool/tool.ts';
import type { ToolContext } from '../../ports/tool/tool/toolContext.ts';
import type { ToolResult } from '../../ports/tool/tool/toolResult.ts';
import type {
  PluginWorkerError,
  PluginWorkerInbound,
  PluginWorkerRequest,
  PluginWorkerToolInvoke,
  PluginWorkerToolRegistration,
} from '../../ports/plugin/pluginWorkerProtocol.ts';

/** Supervisor 构造选项。 */
export interface PluginWorkerSupervisorOptions {
  /** 插件名（仅用于日志与握手）。 */
  readonly pluginName: string;
  /** 插件入口绝对路径。 */
  readonly entryPath: string;
  /** 插件版本（握手用）。 */
  readonly pluginVersion?: string;
  /** Worker 入口（测试可注入；缺省同目录 `pluginWorkerMain.mjs`）。 */
  readonly workerEntry?: string;
  /** 激活超时（毫秒，默认 10s）。 */
  readonly activationTimeoutMs?: number;
  /** 单次工具调用超时（毫秒，默认 30s）。 */
  readonly callTimeoutMs?: number;
}

/** 工具注册回调（父进程据此把工具挂到自己的 ToolPort）。 */
export type PluginWorkerToolRegistrar = (
  registration: PluginWorkerToolRegistration,
) => void | Promise<void>;

/** Worker 生命周期状态。 */
export type PluginWorkerState =
  'spawned' | 'handshaking' | 'activating' | 'ready' | 'stopping' | 'stopped' | 'failed';

/**
 * 插件 Worker 的父进程侧监督器（ADR-0012）。
 *
 * 负责 spawn/握手/请求超时/崩溃收敛/进程树终止。**不**直接接触插件代码，也**不**把宿主
 * 对象交给 Worker；工具注册通过回调交给 `RemotePlugin` 落到父进程 `ToolPort`。
 */
export class PluginWorkerSupervisor {
  /** 当前状态（供诊断/测试）。 */
  public state: PluginWorkerState = 'spawned';
  /** Worker pid（未 spawn 时为 undefined）。 */
  public pid: number | undefined;
  /** 最近一次错误（崩溃/超时）。 */
  public lastError: string | undefined;

  /** Worker 子进程句柄（退出后清空）。 */
  private child: ChildProcessWithoutNullStreams | undefined;
  /** 本次 Worker 会话标识（握手/消息校验）。 */
  private readonly session = `s_${randomBytes(8).toString('hex')}`;
  /** 握手 nonce（防重放/串会话）。 */
  private readonly nonce = randomBytes(16).toString('hex');
  /** 下一个请求 id。 */
  private nextId = 1;
  /** 在途请求表（id → 结算器与超时器）。 */
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  /** 握手成功回调。 */
  private readyResolve: (() => void) | undefined;
  /** 握手失败回调。 */
  private readyReject: ((error: Error) => void) | undefined;
  /** 子进程退出回调。 */
  private exitResolve: (() => void) | undefined;
  /** 子进程退出 Promise（停机等待用）。 */
  private readonly exitPromise: Promise<void>;
  /** 工具注册回调。 */
  private onTool: PluginWorkerToolRegistrar | undefined;
  /** 单次工具调用超时。 */
  private readonly callTimeoutMs: number;
  /** 激活/握手超时。 */
  private readonly activationTimeoutMs: number;

  /**
   * @param options 插件/Worker 配置。
   */
  public constructor(private readonly options: PluginWorkerSupervisorOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.activationTimeoutMs = options.activationTimeoutMs ?? 10_000;
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * 启动 Worker：spawn → 握手 → activate。
   * @param onTool 工具注册回调（在 activate 期间可能被调用）。
   * @returns 无返回值；任一步失败时抛错并终止 Worker。
   */
  public async start(onTool: PluginWorkerToolRegistrar): Promise<void> {
    this.onTool = onTool;
    await this.spawnWorker();
    try {
      await this.request('plugin.activate', {}, this.activationTimeoutMs);
      this.state = 'ready';
    } catch (error) {
      this.fail(`ACTIVATION_TIMEOUT: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 调用远程工具。
   * @param tool 插件内原始工具名。
   * @param call 工具调用。
   * @param context 工具上下文（仅传可序列化字段）。
   * @returns 工具结果；超时/崩溃返回失败结果，不重试。
   */
  public async invoke(tool: string, call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (this.state !== 'ready') {
      return { callId: call.id, ok: false, error: '插件 Worker 不可用' };
    }
    const params: PluginWorkerToolInvoke = {
      callId: call.id,
      tool,
      args: call.arguments,
      context: { sessionId: context.sessionId, workspaceRoot: context.workspaceRoot },
    };
    try {
      const result = (await this.request('tool.invoke', params, this.callTimeoutMs)) as ToolResult;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      return { callId: call.id, ok: false, error: `插件调用失败: ${message}` };
    }
  }

  /**
   * 停止 Worker（先 deactivate，超时后杀进程树）。
   * @returns 无返回值。
   */
  public async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }
    if (this.state === 'failed') {
      if (this.child !== undefined) ProcessTreeKiller.kill(this.child);
      await Promise.race([
        this.exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      return;
    }
    this.state = 'stopping';
    if (this.child !== undefined && this.child.exitCode === null) {
      try {
        await this.request('plugin.deactivate', {}, 2_000);
      } catch {
        /* 停用失败不阻断强杀 */
      }
    }
    if (this.child !== undefined) ProcessTreeKiller.kill(this.child);
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    this.state = 'stopped';
  }

  /**
   * spawn Worker 并完成握手。
   * @returns 无返回值。
   */
  private async spawnWorker(): Promise<void> {
    const workerEntry =
      this.options.workerEntry ?? fileURLToPath(new URL('./pluginWorkerMain.mjs', import.meta.url));
    const permissionArgs =
      process.env['OMNI_PLUGIN_WORKER_PERMISSION'] === '0'
        ? []
        : [
            '--experimental-permission',
            `--allow-fs-read=${dirname(this.options.entryPath)}`,
            `--allow-fs-read=${workerEntry}`,
          ];
    const child = spawn(process.execPath, [...permissionArgs, workerEntry, '--plugin-worker'], {
      cwd: dirname(this.options.entryPath),
      env: {
        OMNI_PLUGIN_WORKER_SESSION: this.session,
        OMNI_PLUGIN_ENTRY: this.options.entryPath,
        OMNI_PLUGIN_NAME: this.options.pluginName,
        SYSTEMROOT: process.env['SystemRoot'] ?? '',
        TEMP: process.env['TEMP'] ?? '',
        TMP: process.env['TMP'] ?? '',
        PATH: process.env['PATH'] ?? '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.pid = child.pid;
    this.state = 'handshaking';
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      log.warn('plugin.worker.stderr', {
        plugin: this.options.pluginName,
        text: chunk.toString('utf8').slice(0, 500),
      });
    });
    child.on('exit', (code, signal) => {
      if (this.state !== 'stopped') {
        this.fail(`WORKER_CRASHED: code=${String(code)} signal=${String(signal)}`);
      }
      this.child = undefined;
      this.exitResolve?.();
    });
    child.on('error', (error) => this.fail(`WORKER_CRASHED: ${error.message}`));
    this.send({
      v: 1,
      kind: 'hello',
      session: this.session,
      nonce: this.nonce,
      plugin: { name: this.options.pluginName, version: this.options.pluginVersion ?? '0.0.0' },
    });
    const timer = setTimeout(() => {
      this.fail('ACTIVATION_TIMEOUT: 握手超时');
    }, this.activationTimeoutMs);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 解析一行协议消息。
   * @param line 原始行。
   * @returns 无返回值。
   */
  private handleLine(line: string): void {
    if (line.length === 0) return;
    if (line.length > 1024 * 1024) {
      this.fail('INVALID_FRAME: 帧超过 1 MiB');
      return;
    }
    let message: PluginWorkerInbound;
    try {
      message = JSON.parse(line) as PluginWorkerInbound;
    } catch {
      this.fail('INVALID_FRAME: JSON 解析失败');
      return;
    }
    if (message.v !== 1 || message.session !== this.session) {
      this.fail('VERSION_MISMATCH: 协议版本/会话不匹配');
      return;
    }
    if (message.kind === 'res') {
      this.settle(message.id, message);
      return;
    }
    if (message.kind === 'evt') {
      void this.handleEvent(message.method, message.params);
    }
  }

  /**
   * 处理 Worker 事件。
   * @param method 事件名。
   * @param params 参数。
   * @returns 无返回值。
   */
  private async handleEvent(method: string, params: unknown): Promise<void> {
    if (method === 'ready') {
      const ready = params as { nonce?: string; pid?: number };
      if (ready.nonce !== this.nonce) {
        this.fail('VERSION_MISMATCH: 握手 nonce 不匹配');
        return;
      }
      this.pid = ready.pid ?? this.pid;
      this.readyResolve?.();
      return;
    }
    if (method === 'tool.register') {
      try {
        await this.onTool?.(params as PluginWorkerToolRegistration);
      } catch (error) {
        this.fail(`INVALID_TOOL: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (method === 'log') {
      const entry = params as { message?: string };
      log.info('plugin.worker.log', {
        plugin: this.options.pluginName,
        message: String(entry.message ?? '').slice(0, 500),
      });
      return;
    }
    if (method === 'fault') {
      const fault = params as PluginWorkerError;
      this.fail(`WORKER_CRASHED: ${fault.message ?? '插件自报故障'}`);
    }
  }

  /**
   * 发送请求并等待响应（带超时；超时即杀 Worker）。
   * @param method 方法名。
   * @param params 参数。
   * @param timeoutMs 超时。
   * @returns 响应结果。
   */
  private request(
    method: PluginWorkerRequest['method'],
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fail(`CALL_TIMEOUT: ${method} 超过 ${String(timeoutMs)}ms`);
        reject(new Error(`CALL_TIMEOUT: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ v: 1, session: this.session, kind: 'req', id, method, params });
    });
  }

  /**
   * 结算一个响应。
   * @param id 请求 id。
   * @param message 响应。
   * @returns 无返回值。
   */
  private settle(id: number, message: Extract<PluginWorkerInbound, { kind: 'res' }>): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
    }
  }

  /**
   * 发送一条消息。
   * @param message 消息。
   * @returns 无返回值。
   */
  private send(message: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(`WORKER_CRASHED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 标记失败并终止子进程树。
   * @param reason 失败原因。
   * @returns 无返回值。
   */
  private fail(reason: string): void {
    if (this.state === 'failed' || this.state === 'stopped') return;
    this.state = 'failed';
    this.lastError = reason;
    this.readyReject?.(new Error(reason));
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    if (this.child !== undefined) {
      ProcessTreeKiller.kill(this.child);
    }
  }
}
