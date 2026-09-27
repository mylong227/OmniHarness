// 失败归因契约：RPC 超时/HTTP 异常**不得**退化成一句无归因的「RPC 错误」。
//
// 复现的缺陷（2026-09-27 用户截图）：
//   后端 `turns.run` 超过 60s 预算 → 超时 reject 冒泡 → httpServer 兜底写 `500 {"error":"internal"}`
//   → 前端 `ApiClient.rpc` 无条件读 `data.error.message`（`"internal"` 是字符串 ⇒ undefined）
//   → 界面只剩「运行失败：RPC 错误。可尝试切换模型或检查 API Key。」，真实的超时原因彻底丢失，
//     且把用户引向「换模型 / 查 API Key」这条错误方向。
//
// 这里钉住三件事：
//   ① HTTP 500 + 非 JSON-RPC 形状的 error ⇒ 报出 HTTP 状态，而不是「RPC 错误」；
//   ② JSON-RPC error 对象 ⇒ 原样报出服务端 message（含超时毫秒数）；
//   ③ 建议语按原因分流：超时给「回合可能仍在后台」而不是「换模型查 Key」。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';

const { ApiClient } = await import('../dist/core/ApiClient.js');
const { ComposerController } = await import('../dist/ui/controllers/ComposerController.js');

/** 用给定响应冒充 fetch，返回 ApiClient.rpc 抛出的错误消息（不抛则返回 null）。 */
async function rpcError(res) {
  global.fetch = async () => res;
  const api = new ApiClient();
  try {
    await api.rpc('turns.run', {});
  } catch (e) {
    return e.message;
  }
  return null;
}

test('① HTTP 500 且 error 不是对象 ⇒ 报出 HTTP 状态（旧实现在此只给「RPC 错误」）', async () => {
  const msg = await rpcError({
    ok: false,
    status: 500,
    json: async () => ({ error: 'internal' }),
  });
  assert.ok(msg !== null, 'HTTP 失败必须抛错');
  assert.notEqual(msg, 'RPC 错误', '不得退化成无归因的「RPC 错误」');
  assert.match(msg, /HTTP 500/);
});

test('② JSON-RPC error 对象 ⇒ 原样报出服务端 message（超时毫秒数可见）', async () => {
  const msg = await rpcError({
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32002, message: 'RPC 超时（1800000ms）' },
    }),
  });
  assert.strictEqual(msg, 'RPC 超时（1800000ms）');
});

test('②b error 对象缺 message ⇒ 带上错误码，仍不留白', async () => {
  const msg = await rpcError({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000 } }),
  });
  assert.match(String(msg), /-32000/);
});

test('③ 建议语按原因分流：超时不再劝「换模型 / 查 API Key」', () => {
  const timeoutHint = ComposerController.failureHint('RPC 超时（1800000ms）');
  assert.match(timeoutHint, /后台/);
  assert.doesNotMatch(timeoutHint, /API Key/);

  const httpHint = ComposerController.failureHint('RPC 请求失败：HTTP 500');
  assert.doesNotMatch(httpHint, /API Key/);

  // 其它原因（如鉴权/模型报错）仍保留原来的建议
  const authHint = ComposerController.failureHint('401 invalid api key');
  assert.match(authHint, /API Key/);
});
