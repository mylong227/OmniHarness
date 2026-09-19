/**
 * cdpClient 单测：验证「断链时在途请求立即失败、不悬到超时」与「协议错误只拒绝对应请求」。
 *
 * 这是真实的并发缺陷来源——browser_screenshot 命中所依赖的 CDP 通道一旦在命令中途断开，
 * 若让 pending 的 Promise 悬到 20s 超时，整轮 agent 会被一个坏掉的浏览器拖死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient } from '../../src/adapters/browser/cdpClient.js';
import type { WebSocketLike } from '../../src/adapters/browser/cdpClient.js';

/** 可控的假 WebSocket：手动派发事件，便于精确模拟「连接中途断开」。 */
class FakeSocket implements WebSocketLike {
  /** 事件类型 → 监听器列表。 */
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  /** 已发出的帧（按序）。 */
  public sent: string[] = [];
  /** close 是否被调用。 */
  public closed = false;

  /**
   * 登记事件监听器。
   *
   * @param type 事件类型（open/message/close/error）
   * @param listener 监听器
   * @returns 无
   */
  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? [];
    set.push(listener);
    this.listeners.set(type, set);
  }

  /**
   * 记录一条出站帧（不真发）。
   *
   * @param data 帧文本
   * @returns 无
   */
  public send(data: string): void {
    this.sent.push(data);
  }

  /**
   * 标记关闭（假实现只置位）。
   *
   * @returns 无
   */
  public close(): void {
    this.closed = true;
  }

  /**
   * 触发一个事件。
   *
   * @param type 事件类型
   * @param event 事件负载
   * @returns 无
   */
  public emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  /**
   * 回一条 CDP 结果帧。
   *
   * @param id 请求 id
   * @param result 结果负载
   * @returns 无
   */
  public respond(id: number, result: unknown): void {
    this.emit('message', { data: JSON.stringify({ id, result }) });
  }

  /**
   * 回一条 CDP 错误帧。
   *
   * @param id 请求 id
   * @param message 错误文本
   * @returns 无
   */
  public respondError(id: number, message: string): void {
    this.emit('message', { data: JSON.stringify({ id, error: { message } }) });
  }

  /**
   * 派发一条事件帧。
   *
   * @param method CDP 事件方法名
   * @param params 事件参数
   * @returns 无
   */
  public emitCdpEvent(method: string, params: unknown): void {
    this.emit('message', { data: JSON.stringify({ method, params }) });
  }

  /**
   * 模拟底层连接中断（error 或 close）。
   *
   * @param kind 断开方式
   * @returns 无
   */
  public drop(kind: 'error' | 'close'): void {
    this.emit(kind, { message: 'boom' });
  }
}

/** 建一个已连接的客户端（假 socket 已 fire open）。 */
const connected = (): { client: CdpClient; socket: FakeSocket } => {
  const socket = new FakeSocket();
  const client = new CdpClient({ webSocket: () => socket, timeoutMs: 1000 });
  const _ready = client.connect('ws://127.0.0.1:9/devtools/browser/x');
  socket.emit('open', {});
  return { client, socket };
};

test('正常响应：send 收 result 解决', async () => {
  const { client, socket } = connected();
  const promise = client.send('Runtime.evaluate', { expression: '1+1' });
  socket.respond(1, { result: { value: 2 } });
  const result = await promise;
  assert.deepStrictEqual(result, { result: { value: 2 } });
  await client.close();
});

test('协议错误帧只拒绝对应请求（其它在途请求不受影响）', async () => {
  const { client, socket } = connected();
  const good = client.send('Page.enable', {});
  const bad = client.send('Page.navigate', { url: 'x' });
  socket.respondError(2, 'invalid url');
  await assert.rejects(bad, /invalid url/);
  socket.respond(1, {});
  await assert.doesNotReject(good); // 同回合另一条命令照常解决
  await client.close();
});

test('连接中途断开：在途请求立即失败（不悬到 20s 超时）', async () => {
  const { client, socket } = connected();
  const pending = client.send('Page.captureScreenshot', {});
  // 不等超时，直接断链 ⇒ pending 必须立刻 reject（不悬到 timeoutMs）。
  socket.drop('error');
  await assert.rejects(pending, /WebSocket (?:错误|已关闭|连接失败)/);
});

test('close() 让全部在途请求立即失败', async () => {
  const { client } = connected();
  const pending = client.send('Page.captureScreenshot', {});
  client.close();
  await assert.rejects(pending, /已关闭/);
});

test('关闭后再次 send 立即抛错（不静默挂起）', async () => {
  const { client } = connected();
  client.close();
  await assert.rejects(client.send('Page.enable', {}), /已关闭/);
});

test('CDP 事件被 on() 订阅者收到', async () => {
  const { client, socket } = connected();
  const seen: unknown[] = [];
  client.on('Page.loadEventFired', (params) => seen.push(params));
  socket.emitCdpEvent('Page.loadEventFired', { timestamp: 7 });
  assert.deepStrictEqual(seen, [{ timestamp: 7 }]);
  await client.close();
});

test('未连接就 send → 抛「尚未连接」', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient({ webSocket: () => socket, timeoutMs: 1000 });
  await assert.rejects(client.send('Page.enable', {}), /尚未连接/);
});
