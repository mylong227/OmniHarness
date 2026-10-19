// 右栏网页地址判定 / 本地地址收集的判据（2026-10-19）。
//
// 这些是纯逻辑（node 环境直测）：地址归一化、协议白名单、工作区路径 fail-closed、
// 以及「预览主机名必须与 UI 不同」这条 cookie 隔离不变量。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PreviewUrl } from '../src/ui/models/PreviewUrl.ts';
import { LocalDevUrls } from '../src/ui/models/LocalDevUrls.ts';

/** UI 在 127.0.0.1、预览源在 9000 的常规上下文。 */
const CTX = { appHost: '127.0.0.1', previewPort: 9000 } as const;

test('absolute：http(s) 原样、主机:端口补协议、裸回环主机补默认端口', () => {
  assert.strictEqual(PreviewUrl.absolute('http://example.com/a'), 'http://example.com/a');
  assert.strictEqual(PreviewUrl.absolute('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(PreviewUrl.absolute('localhost:5173'), 'http://localhost:5173/');
  assert.strictEqual(PreviewUrl.absolute('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.strictEqual(PreviewUrl.absolute('localhost'), 'http://localhost/');
  assert.strictEqual(PreviewUrl.absolute('index.html'), null, '相对路径不是绝对网址');
});

test('absolute：只放行 http(s)——file/javascript/data 一律拒绝', () => {
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>']) {
    assert.strictEqual(PreviewUrl.absolute(bad), null, bad);
    assert.deepStrictEqual(PreviewUrl.parse(bad, CTX), { ok: false, reason: 'invalid' }, bad);
  }
});

test('parse：工作区路径映射到预览源，主机名与 UI **不同**（cookie 隔离）', () => {
  const result = PreviewUrl.parse('examples/site/index.html', CTX);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.target.url, 'http://localhost:9000/examples/site/index.html');
  assert.strictEqual(result.target.title, 'index.html');
  assert.strictEqual(result.target.kind, 'local');
});

test('parse：UI 本身在 localhost 时预览改用 127.0.0.1（仍然换主机名）', () => {
  const result = PreviewUrl.parse('index.html', { appHost: 'localhost', previewPort: 9000 });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.target.url, 'http://127.0.0.1:9000/index.html');
});

test('parse：本地路径 fail-closed（越界 / 无预览源 / 非回环 UI）', () => {
  for (const bad of ['/etc/passwd', '~/secret', 'C:\\Windows\\win.ini', '../outside.txt', 'a/../../b']) {
    assert.deepStrictEqual(PreviewUrl.parse(bad, CTX), { ok: false, reason: 'outside' }, bad);
  }
  assert.deepStrictEqual(PreviewUrl.parse('index.html', { appHost: '127.0.0.1', previewPort: null }), {
    ok: false,
    reason: 'no-preview',
  });
  assert.deepStrictEqual(PreviewUrl.parse('index.html', { appHost: '10.0.0.5', previewPort: 9000 }), {
    ok: false,
    reason: 'no-host',
  });
  assert.deepStrictEqual(PreviewUrl.parse('  ', CTX), { ok: false, reason: 'empty' });
});

test('parse：工作区路径保留查询串 / 片段，且对每段编码', () => {
  const result = PreviewUrl.parse('页面/我的站点.html?x=1#top', CTX);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(
    result.target.url,
    'http://localhost:9000/' +
      encodeURIComponent('页面') +
      '/' +
      encodeURIComponent('我的站点.html') +
      '?x=1#top',
  );
});

test('isLoopbackUrl：只有回环 http(s) 才算（公网 / 非 http 不算）', () => {
  assert.strictEqual(PreviewUrl.isLoopbackUrl('http://localhost:5173/'), true);
  assert.strictEqual(PreviewUrl.isLoopbackUrl('http://127.0.0.1:8787/x'), true);
  assert.strictEqual(PreviewUrl.isLoopbackUrl('https://example.com/'), false);
  assert.strictEqual(PreviewUrl.isLoopbackUrl('file:///C:/x'), false);
});

test('LocalDevUrls.collect：只收回环地址、去重、排除工作台自身地址', () => {
  const text = [
    'dev server 已启动: http://localhost:5173/ 和 http://127.0.0.1:3000/api。',
    '工作台: http://127.0.0.1:8787/?token=secret',
    '公网: https://example.com/',
    '重复: http://localhost:5173/',
  ].join('\n');
  assert.deepStrictEqual(
    LocalDevUrls.collect([text], { excludeHostPort: '127.0.0.1:8787' }),
    ['http://localhost:5173/', 'http://127.0.0.1:3000/api'],
  );
});
