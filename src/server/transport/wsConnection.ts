import { createHash } from 'node:crypto';
import { WsFrameCodec } from './wsFrameCodec.js';
import type { WsParsedFrame } from './wsFrameCodec.js';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server } from 'node:http';

/** WebSocket 连接：RFC6455 帧编解码（文本帧，无第三方依赖）。 */
export class WsConnection {
  /**
   * 单条消息（分片重组后）字节硬上限。
   *
   * 为什么与帧上限分开：RFC6455 允许把一条消息切成**任意多**帧（每帧都可 ≤ 8 MiB），
   * 只限帧不限消息 ⇒ 对端用无数小分片就能把重组缓冲撑爆。上限与帧同量级即可
   * （本服务的消息是 JSON-RPC 与事件推送，KB 级）。
   */
  private static readonly MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

  /** 未消费的字节缓冲（帧跨 TCP 分片时累积解析）。 */
  private buffer: Buffer = Buffer.alloc(0);
  /** 分片重组缓冲（FIN=0 的数据帧按序累积，收到 FIN=1 的续帧才交付）。 */
  private fragments: Buffer[] = [];
  /** 分片重组已累积字节数（与 {@link WsConnection.MAX_MESSAGE_BYTES} 比对）。 */
  private fragmentBytes = 0;
  /** 当前正在重组的分片类型（首帧 opcode：0x1 文本 / 0x2 二进制）。 */
  private fragmentOpcode: number | undefined;

  /**
   * 发送队列字节硬上限（背压兜底）：慢客户端持续积压超过此量即断开连接（fail-closed），
   * 避免单个慢对等方把服务端内存拖垮。正常 JSON-RPC/事件帧为 KB 级，16 MiB 是极宽松上界。
   */
  private static readonly MAX_QUEUE_BYTES = 16 * 1024 * 1024;

  /** 是否已发出关闭帧（ail() 发过带状态码的关闭帧后不再补发空关闭帧）。 */
  private closeFrameSent = false;
  /** 连接是否已关闭（关闭后 send 直接丢弃）。 */
  private closed = false;
  /**
   * 背压发送队列：对端消费慢、`socket.write` 返回 false 时，待发帧暂存于此，待 `'drain'`
   * 后有序 flush。禁止「调用 send 即无限堆积」——那是慢客户端 OOM 的经典路径。
   */
  private readonly sendQueue: Buffer[] = [];
  /** 当前是否处于背压（socket 内部写缓冲已满，需等 drain）。 */
  private paused = false;
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
    // 背压释放：内部写缓冲排空后触发，继续 flush 暂存队列（若有）。
    socket.on('drain', () => {
      if (this.paused) {
        this.paused = false;
        this.drainQueue();
      }
    });
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
   *
   * 背压语义：对端消费慢导致 `socket.write` 返回 false 时，本帧与后续帧进入有界队列，
   * 待 `'drain'` 后有序 flush；队列字节超 {@link WsConnection.MAX_QUEUE_BYTES} 即断开连接
   * （fail-closed），宁可丢弃一个慢对等方也不让服务端内存被拖垮。
   * @param text 待发送的 UTF-8 文本。
   * @returns 无返回值（连接已关闭时直接丢弃）。
   */
  public send(text: string): void {
    if (this.closed) {
      return;
    }
    const frame = WsFrameCodec.buildDataFrame(Buffer.from(text, 'utf8'), 0x1, this.role);
    if (this.paused || this.sendQueue.length > 0) {
      this.enqueue(frame);
      return;
    }
    this.paused = !this.socket.write(frame);
  }

  /**
   * 把帧压入背压队列；超字节上限即 fail-closed 断开（宁可丢慢客户端）。
   * @param frame 待入队帧。
   * @returns 无返回值。
   */
  private enqueue(frame: Buffer): void {
    let bytes = 0;
    for (const queued of this.sendQueue) {
      bytes += queued.length;
    }
    if (bytes + frame.length > WsConnection.MAX_QUEUE_BYTES) {
      this.close();
      return;
    }
    this.sendQueue.push(frame);
    if (!this.paused) {
      this.drainQueue();
    }
  }

  /**
   * 有序 flush 背压队列，直到队列清空或再次背压。
   * @returns 无返回值。
   */
  private drainQueue(): void {
    while (this.sendQueue.length > 0 && !this.paused) {
      const frame = this.sendQueue.shift();
      if (frame === undefined) {
        break;
      }
      this.paused = !this.socket.write(frame);
    }
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
    this.sendQueue.length = 0;
    this.onClose();
    try {
      // 已经通过 `fail()` 发过带状态码的关闭帧时不再补发——RFC6455 只允许一个关闭帧，
      // 连发两个会让对端看到「关闭后还有数据」，部分实现会记为协议错误（1002）。
      this.socket.end(this.closeFrameSent ? Buffer.alloc(0) : Buffer.from([0x88, 0x00]));
    } catch {
      this.socket.destroy();
    }
  }

  /**
   * 累积分片解析帧（RFC6455 §5.4：数据帧可分片，控制帧不可分片且 ≤125 字节）。
   *
   * 2026-10-04 审计（Wave D ④ 传输栈评估）修掉四处**协议一致性缺陷**——原实现只认 `0x1`/`0x8`：
   * ① FIN 位被忽略 ⇒ **分片消息被当完整消息提前交付**（且后续续帧被丢弃=数据截断）；
   * ② 无 ping/pong ⇒ 对端 ping 得不到 pong，第三方客户端会判连接已死；
   * ③ 文本帧不做 UTF-8 校验 ⇒ 非法序列被静默替换成 U+FFFD（规范要求 1007 关闭）；
   * ④ 未校验掩码位 ⇒ 客户端**未掩码**的数据帧被照收（规范要求 1002 关闭；掩码是防中间设备
   *    缓存投毒的一环，放行等于把这条防线交给对端自觉）。
   * 另补 ⑤ 分片重组上限（只限单帧不限消息 ⇒ 无数小分片可撑爆重组缓冲）。
   * @param chunk 新到的字节分片（追加进缓冲后循环取帧）。
   * @returns 无返回值（数据帧交付 `onMessage`，控制帧按规范回应或关闭）。
   */
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = this.takeFrame();
      if (frame === undefined) {
        return;
      }
      if (frame.opcode >= 0x8) {
        this.handleControlFrame(frame);
        if (this.closed) return;
        continue;
      }
      this.handleDataFrame(frame);
      if (this.closed) return;
    }
  }

  /**
   * 处理数据帧（含分片重组与**统一交付点**）。
   *
   * 交付只有一处（末尾）：这样「单帧完整消息」与「分片重组后的消息」走**完全相同**的校验与交付路径——
   * 两处各写一遍必然漂移（第一版单帧路径直接交付、完全跳过 UTF-8 校验，就是这个形态）。
   * @param frame 已解析帧
   * @returns 无返回值
   */
  private handleDataFrame(frame: WsParsedFrame): void {
    if (frame.opcode === 0x0) {
      if (this.fragmentOpcode === undefined) {
        this.fail(1002, '续帧出现在无分片消息时');
        return;
      }
    } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (this.fragmentOpcode !== undefined) {
        this.fail(1002, '新数据帧出现在未完成的分片消息中');
        return;
      }
      this.fragmentOpcode = frame.opcode;
    } else {
      this.fail(1003, `不支持的数据帧 opcode 0x${frame.opcode.toString(16)}`);
      return;
    }

    this.fragments.push(frame.payload);
    this.fragmentBytes += frame.payload.length;
    if (this.fragmentBytes > WsConnection.MAX_MESSAGE_BYTES) {
      this.fail(1009, '分片消息超过重组上限');
      return;
    }
    if (!frame.fin) return;

    const opcode = this.fragmentOpcode ?? 0x1;
    const payload = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = undefined;

    if (opcode !== 0x1) {
      // 二进制：本服务的 WS 只承载 JSON-RPC/事件（文本）。显式拒绝而不是静默丢弃——
      // 静默丢弃会让对端一直等一个永不到来的响应（本仓「静默 ≠ 不可见」的同一取向）。
      this.fail(1003, '本端点只接受文本消息');
      return;
    }
    const decoded = WsFrameCodec.decodeText(payload);
    if (!decoded.ok) {
      this.fail(decoded.code, decoded.reason);
      return;
    }
    if (decoded.text.length > 0) this.onMessage(decoded.text);
  }

  /**
   * 处理控制帧（关闭 / ping / pong）。
   * @param frame 已解析帧
   * @returns 无返回值
   */
  private handleControlFrame(frame: WsParsedFrame): void {
    // 控制帧不得分片且载荷 ≤125 字节（RFC6455 §5.5）。
    if (!frame.fin || frame.payload.length > 125) {
      this.fail(1002, '控制帧不得分片且载荷不得超过 125 字节');
      return;
    }
    if (frame.opcode === 0x8) {
      this.close();
      return;
    }
    if (frame.opcode === 0x9) {
      // ping ⇒ 必须回 pong（否则对端心跳超时，判定链路已死）。
      this.sendControl(0xa, frame.payload);
      return;
    }
    if (frame.opcode === 0xa) return; // pong：无需处理。
    this.fail(1003, `不支持的控制帧 opcode 0x${frame.opcode.toString(16)}`);
  }

  /**
   * 按规范以状态码关闭（先发关闭帧再断开）。
   * @param code 关闭状态码（RFC6455 §7.4.1）
   * @param reason 关闭原因（≤123 字节）
   * @returns 无返回值
   */
  private fail(code: number, reason: string): void {
    this.closeFrameSent = true;
    this.sendControl(0x8, WsFrameCodec.closePayload(code, reason));
    this.close();
  }

  /**
   * 尝试取一帧（数据不足返回 undefined）。
   * @returns FIN / opcode / 载荷；缓冲不足一个完整帧时 undefined。
   */
  private takeFrame(): WsParsedFrame | undefined {
    const step = WsFrameCodec.parse(this.buffer, this.role);
    if (step.kind === 'incomplete') return undefined;
    if (step.kind === 'error') {
      this.fail(step.code, step.reason);
      return undefined;
    }
    this.buffer = this.buffer.subarray(step.consumed);
    return step.frame;
  }

  /**
   * 发送控制帧（服务端不掩码；客户端按 §5.1 掩码——角色判定与数据帧共用编解码器）。
   * @param opcode 控制帧 opcode（0x8/0x9/0xa）
   * @param payload 载荷（≤125 字节）
   * @returns 无返回值
   */
  private sendControl(opcode: number, payload: Buffer): void {
    this.enqueue(WsFrameCodec.buildDataFrame(payload, opcode, this.role));
  }

  /** RFC6455 握手 accept 值：base64(sha1(key + 固定 GUID))。
   * @param key 客户端 `Sec-WebSocket-Key`。
   * @returns 应回填进 `Sec-WebSocket-Accept` 的 base64 串。
   */
  public static webSocketAcceptKey(key: string): string {
    return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
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
    /**
     * 升级前的鉴权裁决（可选）：返回 false 即以 401 拒绝握手。
     * 与 HTTP 路由共用同一守卫（`ServerAuthGuard.verify`），避免「HTTP 设了鉴权、WS 却裸奔」。
     */
    private readonly authorize?: ((request: IncomingMessage) => boolean) | undefined,
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
    if (this.authorize !== undefined && !this.authorize(request)) {
      // 鉴权失败：按 HTTP 语义回 401（而非静默 destroy），让客户端能区分「没权限」与「网络断了」。
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = WsConnection.webSocketAcceptKey(key);
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
