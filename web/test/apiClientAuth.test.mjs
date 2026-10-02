import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../dist/core/ApiClient.js';
import { authToken } from '../dist/core/authToken.js';

/** 用最小桩替换全局 fetch，捕获 URL 与请求头，并返回合法 JSON-RPC 响应。 */
function stubFetch(body) {
  const captured = { url: null, init: null };
  globalThis.fetch = async (url, init) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return captured;
}

test('rpc：配置了令牌时附带 Authorization: Bearer 头', async () => {
  authToken.set('test-token');
  const cap = stubFetch({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  const res = await new ApiClient().rpc('config.get', {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(cap.url, '/rpc');
  assert.strictEqual(cap.init.headers['Content-Type'], 'application/json');
  assert.strictEqual(cap.init.headers['Authorization'], 'Bearer test-token');
  authToken.set('');
});

test('rpc：无令牌时不附带 Authorization 头', async () => {
  authToken.set('');
  const cap = stubFetch({ jsonrpc: '2.0', id: 1, result: {} });
  await new ApiClient().rpc('config.get', {});
  assert.strictEqual(cap.init.headers['Authorization'], undefined);
  authToken.set('');
});

test('fetchMetrics：附带 Authorization: Bearer 头', async () => {
  authToken.set('m-token');
  const cap = stubFetch('# HELP omni_sessions 0\nomni_sessions 0\n');
  await new ApiClient().fetchMetrics();
  assert.strictEqual(cap.url, '/metrics');
  assert.strictEqual(cap.init.headers['Authorization'], 'Bearer m-token');
  authToken.set('');
});
