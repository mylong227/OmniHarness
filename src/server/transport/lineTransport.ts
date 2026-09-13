import type { RpcMessage } from '../core/jsonRpc.js';

/** 传输层抽象：收发 JSON-RPC 消息。 */
export interface Transport {
  send(message: RpcMessage): void;
  onMessage(callback: (message: RpcMessage) => void): void;
}

/** 行式 JSON 传输（stdio / 管道通用）。 */
export class LineTransport implements Transport {
  /** 订阅前的入站消息缓冲（onMessage 注册时回放）。 */
  private readonly queue: RpcMessage[] = [];
  /** 入站消息回调（AppServer 注册）。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /** 构造传输（stdin/stdout 或可编程双端）。 */
  public constructor(
    /** 逐行读取源（收到一行即回调；参数属性，实例字段 `readLine`）。 */
    private readonly readLine: (onLine: (line: string) => void) => void,
    /** 行写出目标（参数属性，实例字段 `writeLine`）。 */
    private readonly writeLine: (line: string) => void,
  ) {
    readLine((line) => {
      const message = this.parseMessage(line);
      if (message !== undefined) {
        if (this.callback !== undefined) {
          this.callback(message);
        } else {
          this.queue.push(message);
        }
      }
    });
  }

  /**
   * 发送消息。
   * @param message 待发送的 RPC 消息（JSON 序列化为一行）。
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    this.writeLine(JSON.stringify(message));
  }

  /**
   * 订阅消息（缓冲的会先回放）。
   * @param callback 入站消息回调（重复注册以最后一次为准）。
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
    for (const buffered of this.queue) {
      callback(buffered);
    }
    this.queue.length = 0;
  }

  /**
   * 解析一行消息。
   * @param line 原始文本行。
   * @returns 解析出的 RPC 消息；空行 / 非法 JSON / 非 RPC 结构返回 undefined。
   */
  private parseMessage(line: string): RpcMessage | undefined {
    const trimmed = line.trim();
    if (trimmed === '') {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && 'jsonrpc' in parsed) {
        return parsed as RpcMessage;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
