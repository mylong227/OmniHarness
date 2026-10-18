import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { ServerAuthGuard } from '../../src/server/transport/serverAuthGuard.ts';

/** 构造最小请求桩：只提供 verify 需要的 url 与可选 authorization / origin 头。 */
function req(url: string, authorization?: string, origin?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers['authorization'] = authorization;
  if (origin !== undefined) headers['origin'] = origin;
  return { url, headers } as unknown as IncomingMessage;
}

test('verify：未启用令牌时一律放行（含带 token 查询参数的 SSE）', () => {
  const guard = new ServerAuthGuard();
  assert.strictEqual(guard.enabled, false);
  assert.strictEqual(guard.verify(req('/rpc')), true);
  assert.strictEqual(guard.verify(req('/events?token=whatever')), true);
});

test('verify：启用令牌 + Authorization 头匹配放行', () => {
  const guard = new ServerAuthGuard('secret');
  assert.strictEqual(guard.verify(req('/rpc', 'Bearer secret')), true);
});

test('verify：启用令牌 + Authorization 头错令牌拒绝', () => {
  const guard = new ServerAuthGuard('secret');
  assert.strictEqual(guard.verify(req('/rpc', 'Bearer wrong')), false);
  assert.strictEqual(guard.verify(req('/rpc', 'Bearer ')), false);
  assert.strictEqual(guard.verify(req('/rpc')), false);
});

test('verify：启用令牌 + SSE ?token= 查询参数匹配放行（EventSource 无法设头）', () => {
  const guard = new ServerAuthGuard('secret');
  assert.strictEqual(guard.verify(req('/events?token=secret')), true);
});

test('verify：启用令牌 + SSE ?token= 错令牌拒绝', () => {
  const guard = new ServerAuthGuard('secret');
  assert.strictEqual(guard.verify(req('/events?token=wrong')), false);
});

test('verify：公开路径 /healthz 不受令牌约束', () => {
  const guard = new ServerAuthGuard('secret');
  assert.strictEqual(guard.verify(req('/healthz')), true);
  assert.strictEqual(guard.verify(req('/healthz?token=secret')), true);
});

test('verify：无令牌时也拒绝跨源浏览器请求（回环 Origin 放行，无 Origin 放行）', () => {
  const guard = new ServerAuthGuard();
  assert.strictEqual(guard.verify(req('/rpc', undefined, 'https://evil.example')), false);
  assert.strictEqual(guard.verify(req('/rpc', undefined, 'null')), false);
  assert.strictEqual(guard.verify(req('/rpc', undefined, 'http://127.0.0.1:8787')), true);
  assert.strictEqual(guard.verify(req('/rpc', undefined, 'http://localhost:8787')), true);
  assert.strictEqual(guard.verify(req('/rpc')), true);
  // 有令牌也照样做 Origin 校验（纵深防御，不靠"攻击者拿不到令牌"）。
  const withToken = new ServerAuthGuard('secret');
  assert.strictEqual(withToken.verify(req('/rpc', 'Bearer secret', 'https://evil.example')), false);
});
