import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Duplex } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { WsConnection } from '../../src/server/transport/wsConnection.js';
import { HttpBridgeTransport } from '../../src/server/transport/httpBridgeTransport.js';

/** 假 TCP socket：可控制 `write` 返回值以模拟背压，并暴露 drain 触发。 */
class FakeSocket {
  /** 已「写出」的帧（每次 write 调用均收集，无论返回值）。 */
  public writes: Buffer[] = [];
  /** 控制 write 返回值：false 模拟对端消费慢（内部缓冲已满）。 */
  public writeReturns = true;
  /** 注册的 drain 回调。 */
  private drainHandler: (() => void) | undefined;

  /**
   * 注册事件回调（仅 'drain' 被本测试关心，其余忽略）。
   * @param event 事件名。
   * @param cb 回调。
   * @returns 无返回值。
   */
  public on(event: string, cb: () => void): void {
    if (event === 'drain') {
      this.drainHandler = cb;
    }
  }

  /**
   * 模拟底层 socket 写；一律记录尝试帧，返回值受 {@link FakeSocket.writeReturns} 控制。
   * @param buf 待写出的帧。
   * @returns 是否写成功（受控）。
   */
  public write(buf: Buffer): boolean {
    this.writes.push(buf);
    return this.writeReturns;
  }

  /**
   * 模拟内部写缓冲排空（触发 socket 'drain'）。
   * @returns 无返回值。
   */
  public fireDrain(): void {
    this.drainHandler?.();
  }

  /**
   * 模拟关闭连接（测试用 no-op）。
   * @returns 无返回值。
   */
  public end(): void {
    /* no-op for test */
  }

  /**
   * 模拟销毁连接（测试用 no-op）。
   * @returns 无返回值。
   */
  public destroy(): void {
    /* no-op for test */
  }
}

/** 假 SSE 响应：可控制 write 返回值以模拟背压，记录是否被丢弃。 */
class FakeSseResponse {
  /** write 调用次数。 */
  public writes = 0;
  /** 控制 write 返回值。 */
  public writeReturns = true;
  /** 是否因背压被丢弃（end 调用）。 */
  public dropped = false;
  /** 注册的 close 回调。 */
  private closeHandler: (() => void) | undefined;

  /**
   * 模拟 SSE 写；记一次调用，返回值受 {@link FakeSseResponse.writeReturns} 控制。
   * @returns 是否写成功（受控）。
   */
  public write(): boolean {
    this.writes += 1;
    return this.writeReturns;
  }

  /**
   * 注册事件回调（仅 'close' 被本测试关心）。
   * @param event 事件名。
   * @param cb 回调。
   * @returns 无返回值。
   */
  public on(event: string, cb: () => void): void {
    if (event === 'close') {
      this.closeHandler = cb;
    }
  }

  /**
   * 模拟断开客户端（背压超阈值时由传输层调用）。
   * @returns 无返回值。
   */
  public end(): void {
    this.dropped = true;
    this.closeHandler?.();
  }
}

test('WsConnection 背压：慢对等方积压后待 drain 有序 flush', () => {
  const socket = new FakeSocket();
  socket.writeReturns = false;
  const conn = new WsConnection(socket as unknown as Duplex);
  conn.send('a'); // 首帧直接写，返回 false ⇒ paused
  assert.strictEqual(socket.writes.length, 1);
  conn.send('b'); // 进入背压队列
  conn.send('c'); // 进入背压队列
  socket.writeReturns = true;
  socket.fireDrain(); // paused → drainQueue 依次写出
  assert.strictEqual(socket.writes.length, 3);
});

test('WsConnection 背压：队列超字节上限即 fail-closed 断开慢对等方', () => {
  const socket = new FakeSocket();
  socket.writeReturns = false;
  let closed = false;
  const conn = new WsConnection(socket as unknown as Duplex);
  conn.onClose = () => {
    closed = true;
  };
  const big = 'x'.repeat(4 * 1024 * 1024); // 4 MiB/帧
  for (let i = 0; i < 6; i += 1) {
    conn.send(big);
  }
  assert.strictEqual(closed, true);
  // 关闭后再次 send 必须静默丢弃，不得抛错或继续堆积。
  conn.send('z');
  assert.strictEqual(socket.writes.length, 1);
});

test('HttpBridgeTransport 广播：SSE 慢客户端连续背压超阈值即丢弃', () => {
  const transport = new HttpBridgeTransport();
  const res = new FakeSseResponse();
  res.writeReturns = false;
  transport.registerSse(res as unknown as ServerResponse);
  for (let i = 0; i < 65; i += 1) {
    transport.notify('evt', { i });
  }
  assert.strictEqual(res.dropped, true);
});

test('HttpBridgeTransport 广播：正常写回即清除背压计数', () => {
  const transport = new HttpBridgeTransport();
  const res = new FakeSseResponse();
  res.writeReturns = true;
  transport.registerSse(res as unknown as ServerResponse);
  transport.notify('evt', { a: 1 });
  transport.notify('evt', { a: 2 });
  assert.strictEqual(res.dropped, false);
  assert.strictEqual(res.writes, 2);
});
