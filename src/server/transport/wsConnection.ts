import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server } from 'node:http';

/** RFC6455 握手 accept 值：base64(sha1(key + 固定 GUID))。
 * @param key 客户端 `Sec-WebSocket-Key`。
 * @returns 应回填进 `Sec-WebSocket-Accept` 的 base64 串。
 */
export function webSocketAcceptKey(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

/** WebSocket 连接：RFC6455 帧编解码（文本帧，零依赖）。 */
export class WsConnection {
  /** 未消费的字节缓冲（帧跨 TCP 分片时累积解析）。 */
  private buffer: Buffer = Buffer.alloc(0);
  /** 连接是否已关闭（关闭后 send 直接丢弃）。 */
  private closed = false;
  /** 消息回调（由外部接管）。 */
  public onMessage: (text: string) => void = () => undefined;
  /** 关闭回调。 */
  public onClose: () => void = () => undefined;

  public constructor(
    /** 升级后的 TCP socket（参数属性，实例字段 `socket`）。 */
    private readonly socket: Duplex,
    /** 握手时携带的 Authorization 头（供服务端鉴权门禁消费，D2）。 */
    public readonly authorization?: string,
    /** 端点角色：服务端发裸帧；客户端发帧须按 RFC6455 掩码（默认 server = 原行为，零变更）。 */
    private readonly role: 'server' | 'client' = 'server',
    /** 握手后随 upgrade 事件一并到达的首批字节（可能含整帧/半帧，客户端侧才可能非空）。 */
    initial?: Buffer,
  ) {
    if (initial !== undefined && initial.length > 0) {
      this.buffer = initial;
    }
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('close', () => this.close());
    // socket 错误（对端重置 / 网络中断 / 握手后被杀）不得以**未捕获异常**炸掉宿主进程：
    // 收敛为一次正常关闭（close 幂等）。缺此监听时，一次 ECONNRESET 就会让整个进程崩溃。
    socket.on('error', () => this.close());
  }

  /**
   * 处理构造期挂起的首批字节（`initial`）。
   * 必须在 `onMessage` 注册之后调用：构造期直接投递会落进默认空回调而被丢弃。
   * @returns 无返回值。
   */
  public flush(): void {
    if (this.buffer.length > 0) {
      this.consume(Buffer.alloc(0));
    }
  }

  /**
   * 发送文本帧。
   * @param text 待发送的 UTF-8 文本。
   * @returns 无返回值（连接已关闭时直接丢弃）。
   */
  public send(text: string): void {
    if (this.closed) {
      return;
    }
    this.socket.write(this.buildFrame(Buffer.from(text, 'utf8')));
  }

  /**
   * 关闭连接。
   * @returns 无返回值（幂等：已关闭直接返回）。
   */
  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
    try {
      this.socket.end(Buffer.from([0x88, 0x00]));
    } catch {
      this.socket.destroy();
    }
  }

  /**
   * 累积分片解析帧。
   * @param chunk 新到的字节分片（追加进缓冲后循环取帧）。
   * @returns 无返回值（关闭帧触发 close，文本帧触发 onMessage）。
   */
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = this.takeFrame();
      if (frame === undefined) {
        return;
      }
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x1 && frame.payload.length > 0) {
        this.onMessage(frame.payload.toString('utf8'));
      }
    }
  }

  /**
   * 尝试取一帧（数据不足返回 undefined）。
   * @returns opcode 与载荷；缓冲不足一个完整帧时 undefined。
   */
  private takeFrame(): { opcode: number; payload: Buffer } | undefined {
    const buffer = this.buffer;
    if (buffer.length < 2) {
      return undefined;
    }
    const opcode = (buffer[0] ?? 0) & 0x0f;
    const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
    let length = (buffer[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) {
        return undefined;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) {
        return undefined;
      }
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey: Buffer | undefined;
    if (masked) {
      if (buffer.length < offset + 4) {
        return undefined;
      }
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) {
      return undefined;
    }
    const raw = buffer.subarray(offset, offset + length);
    const payload = maskKey === undefined ? raw : this.unmask(raw, maskKey);
    this.buffer = buffer.subarray(offset + length);
    return { opcode, payload };
  }

  /**
   * 解客户端掩码。
   * @param raw 掩码后的载荷。
   * @param mask 4 字节掩码键。
   * @returns 异或解掩码后的原始载荷。
   */
  private unmask(raw: Buffer, mask: Buffer): Buffer {
    const out = Buffer.alloc(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      out[index] = (raw[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    return out;
  }

  /**
   * 构造文本帧：服务端发裸帧；客户端按 RFC6455 加 4 字节随机掩码。
   * @param payload 待发送载荷（按长度选 7/16/64 位帧头）。
   * @returns 完整帧字节（0x81 文本帧头 [+ 掩码键] + 载荷）。
   */
  private buildFrame(payload: Buffer): Buffer {
    if (this.role === 'client') {
      return this.buildClientFrame(payload);
    }
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, payload]);
  }

  /**
   * 构造客户端文本帧（RFC6455 要求客户端发出的每一帧都掩码）。
   * @param payload 待发送载荷。
   * @returns 完整帧字节（带掩码位的帧头 + 4 字节掩码键 + 掩码后载荷）。
   */
  private buildClientFrame(payload: Buffer): Buffer {
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    const short = payload.length < 126;
    const mid = !short && payload.length < 65536;
    const header = Buffer.alloc(short ? 2 : mid ? 4 : 10);
    header[0] = 0x81;
    if (short) {
      header[1] = 0x80 | payload.length;
    } else if (mid) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, mask, masked]);
  }
}

/** WebSocket 服务端：HTTP upgrade 握手，连接交由外部接管消息。 */
export class WsServer {
  /** 活跃 socket（含已 upgrade 的）。server.closeAllConnections 覆盖不到 upgrade 后的 socket，
   *  故在此单独登记，供 HttpServer.close() 强制断开——否则关闭时会永久挂起。 */
  private readonly sockets = new Set<Duplex>();

  public constructor(
    httpServer: Server,
    /** 新连接回调（连接建立即通知外部接管消息处理）。 */
    private readonly onConnection: (connection: WsConnection) => void,
  ) {
    httpServer.on('upgrade', (request, socket) => this.upgrade(request, socket));
  }

  /**
   * 强制断开全部已建立的 WebSocket 连接（服务关闭时调用，幂等）。
   * @returns 无返回值。
   */
  public closeAll(): void {
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // 已断开：忽略
      }
    }
    this.sockets.clear();
  }

  /**
   * 握手（RFC6455）。
   * @param request 升级请求（校验 URL 与 Sec-WebSocket-Key）。
   * @param socket 待升级的 socket（校验失败直接销毁）。
   * @returns 无返回值（成功后构造 WsConnection 交外部接管）。
   */
  private upgrade(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key'];
    if (request.url !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = webSocketAcceptKey(key);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const authHeader =
      typeof request.headers['authorization'] === 'string'
        ? request.headers['authorization']
        : undefined;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    this.onConnection(new WsConnection(socket, authHeader));
  }
}
