/**
 * Wave D ④（传输栈评估）审计发现：自研 RFC6455 帧层的**一致性判据**。
 *
 * 评估时实测自研实现（`src/server/transport/wsConnection.ts`）只认 opcode `0x1`/`0x8`，因而有四处
 * 协议一致性缺陷（详见 `docs/TRANSPORT_STACK_EVALUATION_2026-10.md`）。本文件把修好后的行为**逐条钉死**，
 * 每一条都对应一个曾经真实存在的缺陷——**删掉修复即红**：
 *
 * 1. **分片重组**：FIN=0 的首帧不得提前交付；续帧（0x0）按序拼接，FIN=1 才交付完整消息；
 * 2. **ping ⇒ pong**：对端 ping 必须得到载荷相同的 pong（否则第三方客户端判链路已死）；
 * 3. **UTF-8 严格校验**：非法字节序列必须关闭（1007），而不是静默替换成 U+FFFD；
 * 4. **掩码位强制**：服务端收到未掩码帧必须关闭（1002）——掩码是防中间设备缓存投毒的一环；
 * 5. 另补 **分片重组上限**（只限单帧不限消息 ⇒ 无数小分片可撑爆缓冲）与控制帧约束。
 *
 * 判据用假 socket 注入**原始字节**：走 `WebSocket` 客户端只能构造合法帧，测不出这些边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';

import { WsConnection } from '../../src/server/transport/wsConnection.js';
import { WsFrameCodec } from '../../src/server/transport/wsFrameCodec.js';

/** 假 socket：`inbound` 喂原始字节（可读侧），`written` 收集本端写出的字节（可写侧）。 */
class FakeSocket extends Duplex {
  /** 本端写出的字节（服务端发出的帧）。 */
  public readonly written: Buffer[] = [];

  /** @returns 无返回值（无真实读取源，靠 `inbound` 推入）。 */
  public override _read(): void {
    // 无操作：读取侧由 `inbound` 主动推入。
  }

  /**
   * 收集写出的字节。
   * @param chunk 写入的分片
   * @param _encoding 编码（未使用）
   * @param callback 完成回调
   * @returns 无返回值
   */
  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }

  /**
   * 从可读侧推入对端字节。
   * @param bytes 原始字节
   * @returns 无返回值
   */
  public inbound(bytes: Buffer): void {
    this.push(bytes);
  }

  /**
   * 已写出的全部字节（拼接）。
   * @returns 拼接缓冲
   */
  public outbound(): Buffer {
    return Buffer.concat(this.written);
  }
}

/**
 * 喂字节并等可读侧的 `'data'` 派发完成。
 *
 * **为什么必须 await**：Node 流是**异步**派发——`push()` 之后同步断言会看到空数组（本判据第一版
 * 就是这样全红的：不是实现没修好，而是判据没等派发）。这类「判据自己没立住」的坑已在注释里留痕。
 * @param socket 假 socket
 * @param bytes 原始字节
 * @returns 派发完成后 resolve
 */
async function feed(socket: FakeSocket, bytes: Buffer): Promise<void> {
  socket.inbound(bytes);
  await new Promise<void>((resolve) => setImmediate(resolve));
}
/**
 * 构造客户端帧（按 RFC6455 掩码，含 126/127 扩展长度编码）。
 *
 * **为什么必须实现扩展长度**：第一版只写 7 位长度字段，于是「126 字节的控制帧」「1 MiB 的分片」
 * 都编码成了非法帧（126/127 是**转义标记**，不是长度），解析器正确地等后续字节 ⇒ 判据看到「什么都没发生」
 * 而误判为失败。**又是判据夹具的问题，不是实现的问题**（同 §11.3 的「先查变异/夹具是否落地」）。
 * @param payload 载荷
 * @param opts FIN 与 opcode
 * @returns 帧字节
 */
function clientFrame(
  payload: Buffer,
  opts: { readonly fin?: boolean; readonly opcode?: number } = {},
): Buffer {
  const fin = opts.fin !== false;
  const opcode = opts.opcode ?? 0x1;
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  const short = payload.length < 126;
  const mid = !short && payload.length < 65536;
  const header = Buffer.alloc(short ? 2 : mid ? 4 : 10);
  header[0] = (fin ? 0x80 : 0x00) | opcode;
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

/**
 * 造一个服务端角色连接 + 假 socket。
 * @returns 连接、socket 与收到的消息
 */
function serverConnection(): {
  readonly connection: WsConnection;
  readonly socket: FakeSocket;
  readonly messages: string[];
} {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket, undefined, 'server');
  const messages: string[] = [];
  connection.onMessage = (text) => messages.push(text);
  return { connection, socket, messages };
}

test('审计修复①：分片消息按 FIN 重组（首帧不得提前交付，续帧不得丢弃）', async () => {
  const { socket, messages } = serverConnection();
  await feed(socket, clientFrame(Buffer.from('{"a":'), { fin: false }));
  assert.deepStrictEqual(
    messages,
    [],
    'FIN=0 的首帧**不得**当作完整消息交付（修复前这里会被提前交付）',
  );
  await feed(socket, clientFrame(Buffer.from('1}'), { fin: false, opcode: 0x0 }));
  assert.deepStrictEqual(messages, [], '未收齐前仍不得交付');
  await feed(socket, clientFrame(Buffer.from(''), { fin: true, opcode: 0x0 }));
  assert.deepStrictEqual(messages, ['{"a":1}'], 'FIN=1 的续帧到达后必须交付**完整**消息');
});

test('审计修复②：ping 必须回 pong（载荷相同），否则第三方客户端判链路已死', async () => {
  const { socket } = serverConnection();
  await feed(socket, clientFrame(Buffer.from('hb'), { opcode: 0x9 }));
  const out = socket.outbound();
  assert.ok(out.length >= 4, '必须写出 pong 帧');
  assert.strictEqual(out[0], 0x8a, 'opcode 必须是 0xa（pong）且 FIN=1');
  assert.strictEqual(out[1], 2, '载荷长度 2（服务端不掩码）');
  assert.strictEqual(out.subarray(2).toString('utf8'), 'hb', 'pong 必须回显 ping 的载荷');
});

test('审计修复③：非法 UTF-8 文本帧必须关闭（1007），不得静默替换成 U+FFFD', async () => {
  const { socket, messages } = serverConnection();
  // 0xC3 0x28 是经典非法两字节序列（续字节不合法）。
  await feed(socket, clientFrame(Buffer.from([0xc3, 0x28])));
  assert.deepStrictEqual(messages, [], '非法 UTF-8 不得交付给上层');
  const out = socket.outbound();
  assert.strictEqual(out[0], 0x88, '必须发关闭帧');
  assert.strictEqual(
    out.readUInt16BE(2),
    1007,
    '关闭状态码必须是 1007（invalid frame payload data）',
  );
});

test('审计修复④：服务端收到**未掩码**帧必须关闭（1002）——掩码是防缓存投毒的一环', async () => {
  const { socket, messages } = serverConnection();
  // 手工构造未掩码文本帧（服务端→客户端才该这样发；客户端→服务端必须掩码）。
  await feed(socket, Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from('hi')]));
  assert.deepStrictEqual(messages, [], '未掩码帧不得被接受');
  const out = socket.outbound();
  assert.strictEqual(out[0], 0x88, '必须发关闭帧');
  assert.strictEqual(out.readUInt16BE(2), 1002, '关闭状态码必须是 1002（protocol error）');
});

test('审计补充⑤：控制帧不得分片、载荷 ≤125；超限即 1002 关闭', async () => {
  const { socket } = serverConnection();
  await feed(socket, clientFrame(Buffer.from('x'.repeat(126)), { opcode: 0x9 }));
  const out = socket.outbound();
  assert.strictEqual(out[0], 0x88);
  assert.strictEqual(out.readUInt16BE(2), 1002, '超长控制帧必须按协议错误关闭');
});

test('审计补充⑤：分片重组总量有硬上限（无数小分片不得撑爆缓冲）', async () => {
  const { socket, messages } = serverConnection();
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  // 9 × 1 MiB 分片：超过 8 MiB 的重组上限 ⇒ 关闭且不交付。
  await feed(socket, clientFrame(chunk, { fin: false }));
  for (let i = 0; i < 8; i += 1) {
    await feed(socket, clientFrame(chunk, { fin: false, opcode: 0x0 }));
    if (socket.outbound().length > 0) break;
  }
  assert.deepStrictEqual(messages, [], '超限的分片消息不得交付');
  const out = socket.outbound();
  assert.strictEqual(out[0], 0x88, '必须关闭');
  assert.strictEqual(out.readUInt16BE(2), 1009, '关闭状态码必须是 1009（message too big）');
});

test('审计修复不破坏既有语义：正常文本帧仍逐条交付，空文本不触发回调', async () => {
  const { socket, messages } = serverConnection();
  await feed(socket, clientFrame(Buffer.from('{"jsonrpc":"2.0"}')));
  await feed(socket, clientFrame(Buffer.from('')));
  await feed(socket, clientFrame(Buffer.from('{"jsonrpc":"2.0","id":1}')));
  assert.deepStrictEqual(messages, ['{"jsonrpc":"2.0"}', '{"jsonrpc":"2.0","id":1}']);
  // 正对照：服务端主动 send 出去的帧仍是不掩码文本帧（0x81）。
  const { connection, socket: outSocket } = serverConnection();
  connection.send('hello');
  assert.strictEqual(outSocket.outbound()[0], 0x81, '服务端发出的文本帧必须 FIN=1 + 不掩码');
});

test('帧编解码器（单元面）：三种解析结论、扩展长度、掩码判定与关闭载荷', () => {
  // ① 数据不足 ⇒ incomplete（不得当成"空帧"或报错）。
  assert.deepStrictEqual(WsFrameCodec.parse(Buffer.from([0x81]), 'server'), { kind: 'incomplete' });

  // ② 126 扩展长度必须按 16 位大端读（126 是转义标记而非长度）。
  const extended = clientFrame(Buffer.alloc(200, 0x61));
  const step = WsFrameCodec.parse(extended, 'server');
  assert.strictEqual(step.kind, 'frame');
  if (step.kind === 'frame') {
    assert.strictEqual(step.frame.payload.length, 200);
    assert.strictEqual(step.consumed, extended.length, '消费字节数必须覆盖整帧');
  }

  // ③ 掩码位与角色不符 ⇒ 协议错误（服务端收到未掩码帧）。
  const unmasked = Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from('hi')]);
  const masked = WsFrameCodec.parse(unmasked, 'server');
  assert.strictEqual(masked.kind, 'error');
  if (masked.kind === 'error') assert.strictEqual(masked.code, 1002);
  // 反之客户端收到**掩码**帧同样是协议错误（对称判据，防只判一边）。
  const toClient = WsFrameCodec.parse(clientFrame(Buffer.from('hi')), 'client');
  assert.strictEqual(toClient.kind, 'error');

  // ④ 严格 UTF-8：非法序列 ⇒ 1007；合法 ⇒ 原样文本。
  const bad = WsFrameCodec.decodeText(Buffer.from([0xc3, 0x28]));
  assert.strictEqual(bad.ok, false);
  if (!bad.ok) assert.strictEqual(bad.code, 1007);
  assert.deepStrictEqual(WsFrameCodec.decodeText(Buffer.from('{"a":1}')), {
    ok: true,
    text: '{"a":1}',
  });

  // ⑤ 关闭载荷：2 字节大端状态码 + 原因，且总长受控（超长原因截断）。
  const payload = WsFrameCodec.closePayload(1009, 'x'.repeat(300));
  assert.strictEqual(payload.readUInt16BE(0), 1009);
  assert.ok(payload.length <= 125, `关闭载荷不得超过 125 字节（实际 ${String(payload.length)}）`);

  // ⑥ 构造-解析往返：客户端帧掩码、服务端帧不掩码。
  const roundTrip = WsFrameCodec.parse(
    WsFrameCodec.buildDataFrame(Buffer.from('ping'), 0x9, 'client'),
    'server',
  );
  assert.strictEqual(roundTrip.kind, 'frame');
  if (roundTrip.kind === 'frame') {
    assert.strictEqual(roundTrip.frame.opcode, 0x9);
    assert.strictEqual(roundTrip.frame.payload.toString('utf8'), 'ping');
  }
  const serverFrame = WsFrameCodec.buildDataFrame(Buffer.from('hi'), 0x1, 'server');
  assert.strictEqual(serverFrame[1], 2, '服务端帧不得置掩码位（载荷 2 字节）');
});
