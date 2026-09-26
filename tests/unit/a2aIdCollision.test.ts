/**
 * A2A 服务端传输的**并发 id 撞车**回归（2026-09-26 稳定性审计 S1，P0）。
 *
 * 缺陷现场：服务端把挂起请求登记在 `id → resolver` 的一张表里，而**每个 `A2aClient` 的
 * JSON-RPC id 都从 1 开始编号** ⇒ 两个对端并发进来必然撞 id：后到的登记覆盖前一个，
 * 于是「一方拿到别人的响应、另一方永久挂起」（HTTP 侧表现为该请求永不 settle，WS 侧表现为
 * 响应帧被写到后注册的那条连接）。
 *
 * 修法：入库时把 id 改写成**服务端唯一键**再交给处理回调，回写时按唯一键查表并还原对端原始 id。
 * 本用例用两个独立 HTTP 客户端各发 `id=1`，断言各拿各的响应。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HttpA2aServerTransport } from '../../src/a2a/httpA2aTransport.js';
import { WsA2aServerTransport, WsA2aTransport, A2A_WS_PATH } from '../../src/a2a/wsA2aTransport.js';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';

/** 从 JSON-RPC 请求里取出用于回显的业务标记（测试专用字段）。 */
function tagOf(message: RpcMessage): string {
  const params = (message as { params?: { tag?: unknown } }).params;
  return typeof params?.tag === 'string' ? params.tag : '';
}

/** 回显式处理器：把请求里的 tag 原样放进 result，并回填收到的 id。 */
function echoServer(
  transport: { onMessage: (cb: (m: RpcMessage) => void) => void },
  seen: string[],
) {
  transport.onMessage((message) => {
    const tag = tagOf(message);
    seen.push(tag);
    const id = (message as { id?: number | string }).id;
    // 稍作延迟：模拟真实处理器（agent 回合）不是同步返回，从而制造真正的并发重叠。
    setTimeout(() => {
      (transport as unknown as { send: (m: RpcMessage) => void }).send({
        jsonrpc: '2.0',
        id,
        result: { echo: tag },
      } as RpcMessage);
    }, 30);
  });
}

test('HttpA2aServerTransport：两个对端同用 id=1 时各拿各的响应（不串、不挂）', async () => {
  const server = new HttpA2aServerTransport();
  const seen: string[] = [];
  echoServer(server, seen);
  const port = await server.listen(0);
  try {
    const post = async (tag: string): Promise<Record<string, unknown>> => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.delegate', params: { tag } }),
      });
      assert.strictEqual(response.status, 200, `对端 ${tag} 应拿到 200`);
      return (await response.json()) as Record<string, unknown>;
    };
    // 两个对端**同时**发 id=1：旧实现必然一方串味 / 一方挂死（本用例会超时失败）。
    const [a, b] = await Promise.all([post('alpha'), post('beta')]);
    assert.deepStrictEqual(a, { jsonrpc: '2.0', id: 1, result: { echo: 'alpha' } });
    assert.deepStrictEqual(b, { jsonrpc: '2.0', id: 1, result: { echo: 'beta' } });
    assert.deepStrictEqual(seen.sort(), ['alpha', 'beta'], '两条请求都应被处理');
  } finally {
    server.close();
  }
});

test('WsA2aServerTransport：两条连接同用 id=1 时各拿各的响应（不串、不挂）', async () => {
  const server = new WsA2aServerTransport();
  const seen: string[] = [];
  echoServer(server, seen);
  const port = await server.listen(0);
  try {
    const ask = async (tag: string): Promise<RpcMessage> => {
      const ws = new WsA2aTransport(`ws://127.0.0.1:${String(port)}${A2A_WS_PATH}`);
      try {
        const reply = new Promise<RpcMessage>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`对端 ${tag} 未在 3s 内收到响应`)), 3000);
          ws.onMessage((message) => {
            clearTimeout(timer);
            resolve(message);
          });
        });
        // 两个连接**各自**从 id=1 开始编号——这正是撞车条件。
        // `WsA2aTransport.send` 首帧触发懒握手，无需显式 connect。
        ws.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'task.delegate',
          params: { tag },
        } as RpcMessage);
        return await reply;
      } finally {
        ws.close();
      }
    };
    const [a, b] = await Promise.all([ask('alpha'), ask('beta')]);
    assert.deepStrictEqual(a, { jsonrpc: '2.0', id: 1, result: { echo: 'alpha' } });
    assert.deepStrictEqual(b, { jsonrpc: '2.0', id: 1, result: { echo: 'beta' } });
    assert.deepStrictEqual(seen.sort(), ['alpha', 'beta'], '两条请求都应被处理');
  } finally {
    server.close();
  }
});
