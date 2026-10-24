import { createInterface } from 'node:readline';
import type { RpcMessage } from '../server/core/jsonRpc.ts';
import { jsonRpc } from '../server/core/jsonRpc.ts';

/** ACP 传输端口：JSON-RPC 消息的双向收发（stdio / 内存测试替身）。 */
export interface AcpTransport {
  /**
   * 发送一条 JSON-RPC 消息。
   * @param message 待发送消息（请求/响应/通知）。
   */
  send(message: RpcMessage): void;
  /**
   * 订阅入站消息。
   * @param callback 收到消息时的回调。
   */
  onMessage(callback: (message: RpcMessage) => void): void;
  /**
   * 可选：订阅传输关闭（stdin EOF / 进程断开）。
   * @param callback 关闭回调。
   */
  onClose?(callback: () => void): void;
  /** 可选：主动关闭传输。 */
  close?(): void;
}

/**
 * ACP stdio 传输：**换行分隔的 JSON-RPC**（每行一条消息），只写 stdout、只读 stdin。
 *
 * 协议输出绝不能混入日志/横幅：所有诊断信息必须走 stderr，否则编辑器解析器会因
 * 一行非 JSON 内容直接断开连接。
 */
export class AcpStdioTransport implements AcpTransport {
  /** 订阅前收到的入站消息（onMessage 注册时回放）。 */
  private readonly queue: RpcMessage[] = [];
  /** 入站消息回调。 */
  private callback: ((message: RpcMessage) => void) | undefined;
  /** 传输关闭回调集合。 */
  private readonly closeHandlers: (() => void)[] = [];
  /** 是否已关闭。 */
  private closed = false;
  /** 行读取器（stdin）。 */
  private readonly reader: ReturnType<typeof createInterface>;

  /**
   * @param input 入站流（缺省 process.stdin）。
   * @param output 出站流（缺省 process.stdout）。
   */
  public constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.onLine(line));
    this.reader.on('close', () => this.fireClose());
  }

  /**
   * 发送一条消息（JSON + 换行）。
   * @param message JSON-RPC 消息。
   * @returns 无返回值。
   */
  public send(message: RpcMessage): void {
    if (this.closed) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * 订阅入站消息（缓冲消息先回放）。
   * @param callback 消息回调（重复注册以最后一次为准）。
   * @returns 无返回值。
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
    for (const message of this.queue) callback(message);
    this.queue.length = 0;
  }

  /**
   * 订阅关闭（已关闭时在下一次微任务立即回调）。
   * @param callback 关闭回调。
   * @returns 无返回值。
   */
  public onClose(callback: () => void): void {
    if (this.closed) {
      queueMicrotask(callback);
      return;
    }
    this.closeHandlers.push(callback);
  }

  /** 关闭传输（停止读取 stdin，并触发关闭回调）。     * @returns 无返回值。
   */
  public close(): void {
    this.reader.close();
    this.fireClose();
  }

  /**
   * 处理一行输入：解析失败/非 JSON-RPC 结构直接丢弃（不向 stdout 报错）。
   * @param line 原始文本行。
   * @returns 无返回值。
   */
  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    const message = jsonRpc.parse(trimmed);
    if (message === undefined) return;
    if (this.callback !== undefined) {
      this.callback(message);
      return;
    }
    this.queue.push(message);
  }

  /** 标记关闭并一次性触发关闭回调。     * @returns 无返回值。
   */
  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    const handlers = this.closeHandlers.splice(0, this.closeHandlers.length);
    for (const handler of handlers) handler();
  }
}
