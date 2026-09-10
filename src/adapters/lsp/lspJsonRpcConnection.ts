import { spawn, type ChildProcess } from 'node:child_process';

/** JSON-RPC 2.0 消息（宽松结构，仅取我们需要的字段）。 */
interface JsonRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** 单个挂起请求的回调登记。 */
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 默认请求超时（ms）：服务器无响应即 fail-closed 上抛，绝不干等。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** 构造参数：外部命令、启动参数，以及「服务器 → 客户端请求」的应答器。 */
export interface LspJsonRpcConnectionOptions {
  /** 可执行文件（如 node 或 typescript-language-server）。 */
  readonly command: string;
  /** 启动参数。 */
  readonly args: readonly string[];
  /** 应答服务器发起的请求（如 client/registerCapability）；默认回 `{}`。 */
  readonly answerServerRequest?: (method: string) => unknown;
  /** 请求超时毫秒数；默认 15000。 */
  readonly requestTimeoutMs?: number;
}

/**
 * @beta
 * 通用「stdio JSON-RPC 2.0 连接」：负责子进程 spawn、Content-Length 分帧、
 * 请求/通知收发、超时与死亡回收。
 *
 * **单一职责**——只做传输，不懂任何 LSP 语义（LSP 协议逻辑见 `LspProcessAdapter`）。
 * - **懒启动**：由调用方在首个请求前调用 `start()`。
 * - **fail-closed**：进程异常退出或请求超时一律 reject，绝不静默吞掉。
 */
export class LspJsonRpcConnection {
  private proc: ChildProcess | undefined;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private started = false;
  private dead = false;
  private readonly pending = new Map<number, Pending>();

  public constructor(private readonly options: LspJsonRpcConnectionOptions) {}

  /** 子进程是否已异常退出（死亡后所有请求立即 reject）。 */
  public get isDead(): boolean {
    return this.dead;
  }

  /**
   * 启动子进程并接好 stdio（不做任何协议握手）。
   *
   * @returns 无（副作用为 spawn 子进程并挂载 data/exit/error 监听）
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.proc = spawn(this.options.command, [...this.options.args], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    // 吞掉断开后的 EPIPE/ENOPIPE：关闭阶段向已退出的子进程写入属正常竞态，不应上抛。
    this.proc.stdin?.on('error', () => undefined);
    this.proc.stdout?.on('error', () => undefined);
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.on('exit', () => {
      this.dead = true;
      this.failAll(new Error('LSP 子进程已退出'));
    });
    this.proc.on('error', (error: Error) => {
      this.dead = true;
      this.failAll(error);
    });
  }

  /**
   * 发送请求并等待响应。
   *
   * @param method JSON-RPC 方法名
   * @param params 请求参数
   * @returns 服务器返回的 result
   */
  public request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(new Error('LSP 子进程已退出'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * 发送通知（无 id，不等响应）。
   *
   * @param method JSON-RPC 方法名
   * @param params 通知参数
   * @returns 无
   */
  public notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * 优雅关闭：shutdown → exit → kill 回收进程；幂等（未启动直接返回）。
   *
   * @returns 关闭完成
   */
  public async close(): Promise<void> {
    if (!this.started || this.proc === undefined) {
      return;
    }
    try {
      await this.request('shutdown', {});
      this.notify('exit', {});
    } catch {
      // 即便 shutdown 失败也要确保进程被回收。
    } finally {
      this.proc.kill();
      this.reset();
    }
  }

  /**
   * 强制回收：直接 kill + 复位（握手失败时用，不做 shutdown 往返）。
   *
   * @returns 无
   */
  public forceClose(): void {
    this.proc?.kill();
    this.reset();
  }

  /** 写一帧 Content-Length 分帧的 JSON-RPC 消息。 */
  private send(msg: JsonRpcMessage): void {
    const stdin = this.proc?.stdin;
    if (stdin === null || stdin === undefined) {
      throw new Error('LSP 子进程 stdin 不可用');
    }
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    stdin.write(payload);
  }

  /** 从 stdout 分帧并派发消息；非法头丢弃一字节避免死循环。 */
  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null || match[1] === undefined) {
        // 非法头：丢弃一字节，避免死循环。
        this.buf = this.buf.subarray(1);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) {
        return;
      }
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + length);
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(body) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  /** 派发入站消息：响应 → 唤醒挂起请求；服务器请求 → 交由应答器处理；通知 → 忽略。 */
  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error !== undefined) {
          entry.reject(new Error(`LSP 错误: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // 服务器 → 客户端请求（client/registerCapability / workspace/configuration）：尽量应答，避免握手卡死。
      const answer = this.options.answerServerRequest;
      this.send({ jsonrpc: '2.0', id: msg.id, result: answer !== undefined ? answer(msg.method) : {} });
    }
    // 通知（publishDiagnostics / logMessage / $/progress 等）：忽略。
  }

  /** 进程死亡时拒绝所有挂起请求并清空登记。 */
  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** 复位连接状态，使同一实例可重新启动。 */
  private reset(): void {
    this.proc = undefined;
    this.started = false;
    this.dead = false;
    this.buf = Buffer.alloc(0);
  }
}
