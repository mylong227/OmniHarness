import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server } from 'node:http';

/** WebSocket 连接：RFC6455 帧编解码（文本帧，零依赖）。 */
export class WsConnection {
  private buffer = Buffer.alloc(0);
  private closed = false;
  /** 消息回调（由外部接管）。 */
  public onMessage: (text: string) => void = () => undefined;
  /** 关闭回调。 */
  public onClose: () => void = () => undefined;

  public constructor(
    private readonly socket: Duplex,
    /** 握手时携带的 Authorization 头（供服务端鉴权门禁消费，D2）。 */
    public readonly authorization?: string,
  ) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('close', () => this.close());
  }

  /** 发送文本帧。 */
  public send(text: string): void {
    if (this.closed) {
      return;
    }
    this.socket.write(this.buildFrame(Buffer.from(text, 'utf8')));
  }

  /** 关闭连接。 */
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

  /** 累积分片解析帧。 */
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

  /** 尝试取一帧（数据不足返回 undefined）。 */
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

  /** 解客户端掩码。 */
  private unmask(raw: Buffer, mask: Buffer): Buffer {
    const out = Buffer.alloc(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      out[index] = (raw[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    return out;
  }

  /** 构造服务端文本帧（无掩码）。 */
  private buildFrame(payload: Buffer): Buffer {
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
}

/** WebSocket 服务端：HTTP upgrade 握手，连接交由外部接管消息。 */
export class WsServer {
  /** 活跃 socket（含已 upgrade 的）。server.closeAllConnections 覆盖不到 upgrade 后的 socket，
   *  故在此单独登记，供 HttpServer.close() 强制断开——否则关闭时会永久挂起。 */
  private readonly sockets = new Set<Duplex>();

  public constructor(
    httpServer: Server,
    private readonly onConnection: (connection: WsConnection) => void,
  ) {
    httpServer.on('upgrade', (request, socket) => this.upgrade(request, socket));
  }

  /** 强制断开全部已建立的 WebSocket 连接（服务关闭时调用，幂等）。 */
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

  /** 握手（RFC6455）。 */
  private upgrade(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key'];
    if (request.url !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
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
