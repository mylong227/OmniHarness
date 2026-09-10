import type { RpcMessage } from './jsonRpc.js';

/** 传输层抽象：收发 JSON-RPC 消息。 */
export interface Transport {
  send(message: RpcMessage): void;
  onMessage(callback: (message: RpcMessage) => void): void;
}

/** 行式 JSON 传输（stdio / 管道通用）。 */
export class LineTransport implements Transport {
  private readonly queue: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;

  /** 构造传输（stdin/stdout 或可编程双端）。 */
  public constructor(
    private readonly readLine: (onLine: (line: string) => void) => void,
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

  /** 发送消息。 */
  public send(message: RpcMessage): void {
    this.writeLine(JSON.stringify(message));
  }

  /** 订阅消息（缓冲的会先回放）。 */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
    for (const buffered of this.queue) {
      callback(buffered);
    }
    this.queue.length = 0;
  }

  /** 解析一行消息。 */
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
