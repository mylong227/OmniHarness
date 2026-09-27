/**
 * RPC 等待预算**按方法**分配 + 超时**必须落成可解释的 error 响应**
 * （2026-09-27 用户报「运行失败：RPC 错误。可尝试切换模型或检查 API Key。」的修复）。
 *
 * ## 缺陷形态（实测）
 *
 * ① `HttpBridgeTransport` 原先对**所有** RPC 一律用 60s 上限；而 `turns.run` 是**同步等待整个回合**的
 *    （UI 的 `api.runTurn` await 到回合结束），带工具的回合动辄几分钟 ⇒ 到点即报错，**服务端却还在跑**
 *    （状态分叉：错误横幅之后仍有工具调用完成）。服务端日志反复出现
 *    `http.route.failed /rpc: RPC 超时（60000ms）` 即此。
 * ② 超时 reject 原先冒泡到 `httpServer` 的 route 兜底，写出 `500 {"error":"internal"}`；而前端
 *    `ApiClient` 无条件读 `data.error.message` —— `"internal"` 是字符串 ⇒ `.message` 为 undefined ⇒
 *    界面只剩一句无归因的「RPC 错误」。真实原因（超时）在客户端 100% 丢失。
 *
 * ## 本文件的判据
 *
 * ① 映射（纯函数）：长任务方法走 30min，普通方法仍 60s；未知方法按普通处理（fail-closed 到严的一侧）；
 * ② 错误码映射：超时 `-32002`，其它 `-32000`；
 * ③ 行为（真跑一遍超时路径）：用注入的毫秒级预算证明 `handlePost` **真的按方法取预算**——
 *    同一个「慢 200ms」的处理器，`turns.run` 拿到 result，`sessions.list` 拿到带真实原因的超时错误。
 *    若把预算退回「一律 60s」的一刀切，③ 第二半仍超时（注入的是 60ms），第一半则不再通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBridgeTransport } from '../../src/server/transport/httpBridgeTransport.js';
import type { RpcMessage, RpcRequest } from '../../src/server/core/jsonRpc.js';

test('① 预算映射：长任务方法走长预算，普通方法仍 60s，未知方法按普通处理', () => {
  assert.strictEqual(
    HttpBridgeTransport.timeoutFor('turns.run'),
    HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS,
  );
  assert.strictEqual(
    HttpBridgeTransport.timeoutFor('threads.create'),
    HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS,
  );
  assert.strictEqual(
    HttpBridgeTransport.timeoutFor('threads.continue'),
    HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS,
  );
  assert.strictEqual(
    HttpBridgeTransport.timeoutFor('graph.run'),
    HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS,
  );
  assert.strictEqual(
    HttpBridgeTransport.timeoutFor('sessions.list'),
    HttpBridgeTransport.REQUEST_TIMEOUT_MS,
  );
  assert.strictEqual(
    HttpBridgeTransport.timeoutFor('config.get'),
    HttpBridgeTransport.REQUEST_TIMEOUT_MS,
  );
  // 未知方法按**普通**预算处理：宁可早收敛成一条可解释错误，也不给未知方法放 30min。
  assert.strictEqual(
    HttpBridgeTransport.timeoutFor('no.such.method'),
    HttpBridgeTransport.REQUEST_TIMEOUT_MS,
  );
  // 长预算必须显著大于普通预算（否则「分开」没有意义）
  assert.ok(
    HttpBridgeTransport.LONG_REQUEST_TIMEOUT_MS >= 10 * HttpBridgeTransport.REQUEST_TIMEOUT_MS,
  );
});

test('② 错误码映射：超时 -32002（可继续等待/中止），其它 -32000', () => {
  assert.strictEqual(HttpBridgeTransport.errorCodeFor('RPC 超时（1800000ms）'), -32002);
  assert.strictEqual(HttpBridgeTransport.errorCodeFor('boom'), -32000);
  assert.strictEqual(HttpBridgeTransport.errorCodeFor(''), -32000);
});

/**
 * 造一个「慢处理器」传输：收到请求后等 sleepMs 再回结果。
 * @param sleepMs 处理器耗时（毫秒）。
 * @param timeouts 注入的毫秒级预算。
 * @returns 传输实例。
 */
function makeSlowTransport(
  sleepMs: number,
  timeouts: { normalMs: number; longMs: number },
): HttpBridgeTransport {
  const transport = new HttpBridgeTransport(undefined, timeouts);
  transport.onMessage((message: RpcMessage) => {
    const request = message as RpcRequest;
    setTimeout(() => {
      transport.send({ jsonrpc: '2.0', id: request.id, result: { ok: true } } as RpcMessage);
    }, sleepMs);
  });
  return transport;
}

test('③ 行为：同一「慢 200ms」处理器下，turns.run 拿到结果、sessions.list 拿到超时错误', async () => {
  const BUDGET = { normalMs: 60, longMs: 800 };
  const slow = 200;

  const long = makeSlowTransport(slow, BUDGET);
  const longRes = (await long.handlePost(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'turns.run', params: {} }),
  )) as { result?: unknown; error?: { code?: number; message?: string } };
  assert.ok(
    longRes.result !== undefined,
    `长任务方法必须按长预算等待（实测：${JSON.stringify(longRes)}）`,
  );
  assert.strictEqual(longRes.error, undefined);

  const normal = makeSlowTransport(slow, BUDGET);
  const normalRes = (await normal.handlePost(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'sessions.list', params: {} }),
  )) as { result?: unknown; error?: { code?: number; message?: string } };
  assert.ok(
    normalRes.error !== undefined,
    '普通方法超过普通预算必须收敛为一条可解释的错误响应（不得抛出、不得悬挂）',
  );
  assert.match(String(normalRes.error.message), /RPC 超时（60ms）/);
  assert.strictEqual(normalRes.error.code, -32002);
});
