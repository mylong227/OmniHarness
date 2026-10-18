import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ApiClient } from '../src/core/ApiClient.ts';
import { authToken } from '../src/core/authToken.ts';

/**
 * 用最小桩替换全局 fetch，捕获 URL 与请求头，并返回合法 JSON-RPC 响应。
 * @param body 响应体（JSON-RPC 对象或 metrics 文本）
 * @returns 捕获到的 fetch 实参（url / init）
 */
function stubFetch(body: unknown) {
  // 形状对齐全局 fetch 的实参类型（url: URL | RequestInfo；init: RequestInit | undefined）
  const captured: { url: URL | Request | string | null; init: RequestInit | null } = { url: null, init: null };
  globalThis.fetch = async (url, init) => {
    captured.url = url;
    captured.init = init ?? null;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return captured;
}

test('rpc：配置了令牌时附带 Authorization: Bearer 头', async () => {
  authToken.set('test-token');
  const cap = stubFetch({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  const res = await new ApiClient().rpc<{ ok: boolean }>('config.get', {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(cap.url, '/rpc');
  // headers 在本桩里由 buildHeaders 构造，运行时是普通字符串表
  const headers = cap.init!.headers as Record<string, string>;
  assert.strictEqual(headers['Content-Type'], 'application/json');
  assert.strictEqual(headers['Authorization'], 'Bearer test-token');
  authToken.set('');
});

test('rpc：无令牌时不附带 Authorization 头', async () => {
  authToken.set('');
  const cap = stubFetch({ jsonrpc: '2.0', id: 1, result: {} });
  await new ApiClient().rpc('config.get', {});
  const headers2 = cap.init!.headers as Record<string, string>;
  assert.strictEqual(headers2['Authorization'], undefined);
  authToken.set('');
});

test('fetchMetrics：附带 Authorization: Bearer 头', async () => {
  authToken.set('m-token');
  const cap = stubFetch('# HELP omni_sessions 0\nomni_sessions 0\n');
  await new ApiClient().fetchMetrics();
  assert.strictEqual(cap.url, '/metrics');
  const headers3 = cap.init!.headers as Record<string, string>;
  assert.strictEqual(headers3['Authorization'], 'Bearer m-token');
  authToken.set('');
});
