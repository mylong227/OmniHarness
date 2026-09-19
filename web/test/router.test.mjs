// F8 路由 / 深链：Router 纯函数契约测试。
// 验证 parseHash / toHash 往返、非法面板回落、navigate 写入 hash。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';

const { parseHash, toHash, navigate, isValidPane } = await import('../dist/core/Router.js');

/** 设置全局 location（node 默认无 location）。 */
function withHash(hash) {
  globalThis.location = { hash };
}

test('空 hash 回落默认路由（pane=tools, threadId=null）', () => {
  withHash('');
  assert.deepEqual(parseHash(), { pane: 'tools', threadId: null });
});

test('解析 pane + thread 深链', () => {
  withHash('#pane=settings&thread=abc-123');
  assert.deepEqual(parseHash(), { pane: 'settings', threadId: 'abc-123' });
});

test('toHash 与 parseHash 往返一致', () => {
  const route = { pane: 'changes', threadId: 'sess-9' };
  withHash(toHash(route));
  assert.deepEqual(parseHash(), route);
});

test('thread 为空串时归一为 null', () => {
  withHash('#pane=metrics&thread=');
  assert.deepEqual(parseHash(), { pane: 'metrics', threadId: null });
});

test('非法面板标识回落 tools', () => {
  withHash('#pane=not_a_pane&thread=x');
  assert.deepEqual(parseHash(), { pane: 'tools', threadId: 'x' });
});

test('navigate 写入 location.hash', () => {
  withHash('');
  navigate({ pane: 'profiles', threadId: 't-1' });
  assert.equal(globalThis.location.hash, '#pane=profiles&thread=t-1');
});

test('isValidPane 仅放行已知面板', () => {
  assert.equal(isValidPane('settings'), true);
  assert.equal(isValidPane('bogus'), false);
});
