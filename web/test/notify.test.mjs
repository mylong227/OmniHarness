// 通知纯函数契约测试：为 formatProfilePluginToast 上护栏。
// 纯函数、无副作用、无 DOM 依赖，直接 import 编译产物即可运行。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import test from 'node:test';

const { formatProfilePluginToast } = await import('../dist/ui/notify.js');

test('profile.error 转错误 toast', () => {
  const r = formatProfilePluginToast('profile.error', { name: 'web', error: '权限不足' });
  assert.deepEqual(r, { message: '插件集「web」应用失败：权限不足', kind: 'err' });
});

test('plugin.loadError（带 name）转错误 toast', () => {
  const r = formatProfilePluginToast('plugin.loadError', { name: 'foo', error: 'E1' });
  assert.deepEqual(r, { message: '插件「foo」加载失败：E1', kind: 'err' });
});

test('plugin.loadError（无 name）转错误 toast', () => {
  const r = formatProfilePluginToast('plugin.loadError', { error: 'E2' });
  assert.deepEqual(r, { message: '插件加载失败：E2', kind: 'err' });
});

test('plugin.loaded（首次）转成功 toast', () => {
  const r = formatProfilePluginToast('plugin.loaded', { names: ['a', 'b'] });
  assert.deepEqual(r, { message: '已加载插件：a、b', kind: 'ok' });
});

test('plugin.loaded（reloaded）转重载 toast', () => {
  const r = formatProfilePluginToast('plugin.loaded', { names: ['a'], reloaded: true });
  assert.deepEqual(r, { message: '已重新加载插件：a', kind: 'ok' });
});

test('profile.applied 转成功 toast', () => {
  const r = formatProfilePluginToast('profile.applied', { name: 'full', installed: ['x'] });
  assert.deepEqual(r, { message: '已应用插件集「full」', kind: 'ok' });
});

test('非覆盖方法返回 null', () => {
  assert.equal(formatProfilePluginToast('thread.event', {}), null);
  assert.equal(formatProfilePluginToast('profile.event', { type: 'load', name: 'x' }), null);
});

test('参数类型异常时回落安全文案，不抛错', () => {
  const r = formatProfilePluginToast('profile.error', { name: 123, error: null });
  assert.deepEqual(r, { message: '插件集「未知」应用失败：未知错误', kind: 'err' });
  const r2 = formatProfilePluginToast('plugin.loaded', { names: 'not-array' });
  assert.deepEqual(r2, { message: '已加载插件：', kind: 'ok' });
});
