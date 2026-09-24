/**
 * 零依赖 CDP（Chrome DevTools Protocol）客户端。
 *
 * 为什么不引库：Node 22 自带全局 `fetch` 与 `WebSocket`，而截图只需要 CDP 的极小子集
 * （Page / Runtime / Target / Emulation）。为此引入 puppeteer 会带来上百个传递依赖
 * （本仓 `dependency-allowlist.json` 对运行时依赖有准入）。
 *
 * ## 唯一真正难的地方：**不能让请求永远悬着**
 *
 * CDP 是「发出去等回信」的协议。若浏览器崩了、页面被关了、WebSocket 断了，
 * 一个只在 `message` 上 resolve 的实现会让 promise **永久 pending**——
 * 在 agent 主循环里这等于整轮任务无限期挂死（本仓历史上已被这类 bug 咬过一次：
 * 见 `requestStallGuard` 的注释）。故本类对**每条**在途请求都挂定时器，
 * 并在 socket `error` / `close` 时**一次性拒绝全部在途请求**。
 *
 * 事件（`Page.loadEventFired` 等）走 {@link CdpClient.on}，与请求共用同一条连接。
 */

import { endpointDefaults } from '../../util/endpointDefaults.js';
import { PendingRequests } from '../../util/pendingRequests.js';

/** 事件监听器。 */
type EventListener = (params: unknown) => void;

/** 客户端选项。 */
export interface CdpClientOptions {
  /** 单条命令的超时毫秒数（默认 20s）。 */
  readonly timeoutMs?: number | undefined;
  /** 连接建立的超时毫秒数（默认 15s）。 */
  readonly connectTimeoutMs?: number | undefined;
  /** WebSocket 构造器（默认全局 `WebSocket`，测试可注入假实现）。 */
  readonly webSocket?: ((url: string) => WebSocketLike) | undefined;
}

/** 本类用到的最小 WebSocket 面（避免依赖 DOM lib 类型）。 */
export interface WebSocketLike {
  /** 发送文本帧。 */
  send(data: string): void;
  /** 关闭连接。 */
  close(): void;
  /** 事件订阅（Node 全局 WebSocket 兼容 EventTarget 接口）。 */
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * CDP 客户端：面向单一 WebSocket 端点的命令 / 事件复用通道。
 *
 * **不变量（本类最重要的一条）**：不允许任何 promise 永久悬着——每条命令要么被回执兑现/拒绝，
 * 要么被超时收尾，要么在 socket `error`/`close` 与 {@link close} 时由 `pending.failAll` 一次性拒绝。
 */
export class CdpClient {
  /** 默认单条命令超时。 */
  public static readonly DEFAULT_TIMEOUT_MS = 20_000;

  /** 默认连接超时。 */
  public static readonly DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

  /** 在途请求表：CDP id → 收尾通道（超时 / 断开一律收尾，见 util/pendingRequests）。 */
  private readonly pending = new PendingRequests<number, unknown>();

  /** 事件监听表：CDP 方法名 → 监听器集合。 */
  private readonly listeners = new Map<string, Set<EventListener>>();

  /** 命令 id 自增器。 */
  private nextId = 1;

  /** 底层连接（连接完成后才有值）。 */
  private socket: WebSocketLike | undefined;

  /** 是否已停止（close 后为 true，用于把「晚到的错误」转成即时拒绝）。 */
  private closed = false;

  /** 单条命令超时毫秒数。 */
  private readonly timeoutMs: number;

  /** 连接超时毫秒数。 */
  private readonly connectTimeoutMs: number;

  /** WebSocket 构造器。 */
  private readonly webSocketFactory: (url: string) => WebSocketLike;

  public constructor(options: CdpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? CdpClient.DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CdpClient.DEFAULT_CONNECT_TIMEOUT_MS;
    const injected = options.webSocket;
    if (injected !== undefined) {
      this.webSocketFactory = injected;
      return;
    }
    const globalWs = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike })
      .WebSocket;
    if (globalWs === undefined) {
      throw new Error('当前 Node 运行时不提供全局 WebSocket（需 Node >= 22）');
    }
    this.webSocketFactory = (url: string): WebSocketLike => new globalWs(url);
  }

  /**
   * 建立连接（超时即失败；失败后不留下半开的 socket）。
   *
   * @param url 端点的 WebSocket 地址。
   * @returns 连接就绪。
   */
  public async connect(url: string): Promise<void> {
    const socket = this.webSocketFactory(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      // 定时器必须在**订阅之前**就位（假实现可能在订阅时同步触发 open/close），
      // 而 `finish` 只会在它之后就绪之后被调用，故此处声明即可满足 read-before-assign。
      const timer = setTimeout(() => {
        finish(new Error(`CDP 连接超时（${String(this.connectTimeoutMs)}ms）: ${url}`));
        socket.close();
      }, this.connectTimeoutMs);
      socket.addEventListener('open', () => {
        finish();
      });
      // error / close 用的是**常驻**监听器：连接阶段用来拒绝 connect，
      // 连接之后用来让全部在途请求立即失败——否则一条断掉的连接会让后续命令悬到超时，
      // 而在 agent 主循环里「悬着」比「报错」危险得多。
      socket.addEventListener('error', () => {
        finish(new Error(`CDP 连接失败: ${url}`));
        this.pending.failAll(new Error('CDP WebSocket 错误'));
      });
      socket.addEventListener('close', () => {
        finish(new Error(`CDP 连接在就绪前被关闭: ${url}`));
        this.pending.failAll(new Error('CDP WebSocket 已关闭'));
      });
      socket.addEventListener('message', (event) => this.onMessage(event));
    });
  }

  /**
   * 发送一条命令并等待结果。
   *
   * @param method CDP 方法名（如 `Page.captureScreenshot`）。
   * @param params 参数对象。
   * @param sessionId 目标会话 id（`Target.attachToTarget` 得到；不传则发给浏览器级）。
   * @returns 该命令的 `result`（未定义时为空对象）。
   */
  public async send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error('CDP 客户端已关闭');
    }
    const socket = this.socket;
    if (socket === undefined) {
      throw new Error('CDP 客户端尚未连接');
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify(
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId },
    );
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.register(
        id,
        { resolve, reject },
        {
          ms: this.timeoutMs,
          onTimeout: (handlers) =>
            handlers.reject?.(new Error(`CDP 命令超时（${String(this.timeoutMs)}ms）: ${method}`)),
        },
      );
      try {
        socket.send(payload);
      } catch (error) {
        this.pending.fail(id, new Error(`CDP 命令发送失败: ${method}（${String(error)}）`));
      }
    });
  }

  /**
   * 订阅一条 CDP 事件。
   *
   * @param method 事件名（如 `Page.loadEventFired`）。
   * @param listener 回调（收参数对象）。
   * @returns 取消订阅函数。
   */
  public on(method: string, listener: EventListener): () => void {
    const set = this.listeners.get(method) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(method, set);
    return () => {
      set.delete(listener);
    };
  }

  /**
   * 关闭连接。幂等；关闭后所有在途请求立即失败、后续 `send` 直接抛错。
   *
   * @returns 无返回值。
   */
  public close(): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.pending.failAll(new Error('CDP 客户端已关闭'));
    try {
      socket?.close();
    } catch {
      /* 已断开 */
    }
  }

  /**
   * 探测一个调试端口的版本信息（用于「附着到已在运行的浏览器」）。
   *
   * @param port 调试端口。
   * @returns `/json/version` 的 JSON（形状由浏览器决定）。
   */
  public static async version(port: number): Promise<unknown> {
    const probeUrl = endpointDefaults.urlOf('cdpProbeUrl').replace('{port}', String(port));
    const response = await fetch(probeUrl);
    if (!response.ok) {
      throw new Error(
        `CDP ${endpointDefaults.urlOf('cdpVersionPath')} 返回 ${String(response.status)}`,
      );
    }
    return await response.json();
  }

  /**
   * 处理一条入站消息：有 `id` 即命令回执，否则派发给事件监听器。
   *
   * @param event WebSocket 消息事件。
   * @returns 无返回值。
   */
  private onMessage(event: unknown): void {
    const data = (event as { data?: unknown }).data;
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString('utf8');
    } else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    } else {
      return;
    }
    let message: {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: unknown;
      params?: unknown;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      this.settle(message.id, message);
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params);
        } catch {
          // 监听器自身的异常不该拖垮协议通道。
        }
      }
    }
  }

  /**
   * 结算一条在途请求（成功或失败）。
   *
   * @param id 命令 id。
   * @param message 回执消息。
   * @returns 无返回值。
   */
  private settle(id: number, message: { result?: unknown; error?: unknown }): void {
    const handlers = this.pending.take(id);
    if (handlers === undefined) {
      return;
    }
    const error = message.error;
    if (error !== undefined && error !== null) {
      handlers.reject?.(new Error(CdpClient.describeError(error)));
      return;
    }
    handlers.resolve(message.result ?? {});
  }

  /**
   * 把 CDP 错误对象转成可读消息。
   *
   * @param error 原始 error 字段。
   * @returns 消息文本。
   */
  private static describeError(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'message' in error) {
      return String((error as { message: unknown }).message);
    }
    return String(error);
  }
}
