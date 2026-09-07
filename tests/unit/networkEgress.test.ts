import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NetworkEgressGuard,
  EgressBlockedError,
  parseAllowList,
} from '../../src/adapters/sandbox/networkEgress.js';

test('parseAllowList：逗号分隔去空白，空串返回空数组', () => {
  assert.deepStrictEqual(parseAllowList('example.com, api.example.com'), [
    'example.com',
    'api.example.com',
  ]);
  assert.deepStrictEqual(parseAllowList(undefined), []);
  assert.deepStrictEqual(parseAllowList('   '), []);
});

test('NetworkEgressGuard：白名单命中放行（含子域/端口/大小写）', () => {
  const guard = new NetworkEgressGuard({ allowedHosts: ['example.com'] });
  assert.doesNotThrow(() => guard.assertAllowed('https://example.com/v1/chat'));
  assert.doesNotThrow(() => guard.assertAllowed('http://api.example.com:8080/path'));
  assert.doesNotThrow(() => guard.assertAllowed('HTTPS://EXAMPLE.COM'));
});

test('NetworkEgressGuard：非白名单 fail-closed 拒绝', () => {
  const guard = new NetworkEgressGuard({ allowedHosts: ['example.com'] });
  assert.throws(
    () => guard.assertAllowed('https://evil.com/x'),
    (err: unknown) => err instanceof EgressBlockedError,
  );
  assert.throws(
    () => guard.assertAllowed('https://notexample.com/'),
    (err: unknown) => err instanceof EgressBlockedError,
  );
});

test('NetworkEgressGuard：wrapFetch 放行命中、拦截未命中', async () => {
  const guard = new NetworkEgressGuard({ allowedHosts: ['example.com'] });
  let hit = 0;
  const fakeFetch = (async (_input: Parameters<typeof fetch>[0]) => {
    hit += 1;
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const wrapped = guard.wrapFetch(fakeFetch);
  await wrapped('https://example.com/a');
  assert.strictEqual(hit, 1);
  await assert.rejects(
    () => wrapped('https://blocked.com'),
    (e: unknown) => e instanceof Error && e.message.includes('不在白名单'),
  );
  assert.strictEqual(hit, 1); // 拦截时不触达原始 fetch
});

test('NetworkEgressGuard：SSRF 私有/链路本地地址无论白名单一律拒绝', () => {
  // 即便把云元数据 IP / localhost 写进白名单，也应被 SSRF 规则拦截（白名单不能覆盖内网）。
  const guard = new NetworkEgressGuard({
    allowedHosts: ['169.254.169.254', 'localhost', 'example.com'],
  });
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/',
    'http://127.0.0.1:6379/',
    'http://192.168.1.10/',
    'http://172.16.0.5/',
    'http://10.0.0.2/',
    'http://100.64.0.1/',
    'http://[::1]/',
  ]) {
    assert.throws(
      () => guard.assertAllowed(url),
      (err: unknown) => err instanceof EgressBlockedError && err.message.includes('私有/链路本地'),
      `应拦截 SSRF 地址: ${url}`,
    );
  }
  // 公网白名单仍正常放行
  assert.doesNotThrow(() => guard.assertAllowed('https://example.com/x'));
});

test('NetworkEgressGuard：blockPrivateRanges=false 放行受信本地地址（逃生口）', () => {
  const guard = new NetworkEgressGuard({ allowedHosts: ['localhost'], blockPrivateRanges: false });
  assert.doesNotThrow(() => guard.assertAllowed('http://localhost:8080/'));
  // 白名单之外仍拒绝
  assert.throws(
    () => guard.assertAllowed('https://example.com/'),
    (err: unknown) => err instanceof EgressBlockedError,
  );
});
