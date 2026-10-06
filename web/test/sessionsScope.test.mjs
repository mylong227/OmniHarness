// 会话显示范围（当前项目 / 全部项目）的本机偏好：解析、写回、翻转、RPC 参数映射。
//
// 为什么把它单独测：这个开关就是"我的项目数据去哪了"的答案——存档在全局目录、按项目标记归属，
// 缺省只显示当前项目（防淹没），但**必须**能一键看到全部。偏好读写出错时不得影响功能，
// 故非法值/隐私模式一律回落 `current`。
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionsScope } from '../dist/ui/models/SessionsScope.js';

/** 装一个最小 localStorage（Node 无 DOM）。 */
function withStorage(initial) {
  const store = new Map(Object.entries(initial ?? {}));
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  return store;
}

test('缺省/非法值一律回落「当前项目」（fail-safe 默认）', () => {
  withStorage();
  assert.equal(SessionsScope.read(), 'current');
  withStorage({ 'omni-sessions-scope': 'bogus' });
  assert.equal(SessionsScope.read(), 'current');
  withStorage({ 'omni-sessions-scope': 'all' });
  assert.equal(SessionsScope.read(), 'all');
});

test('写回 → 读回一致；翻转在两个模式间来回', () => {
  const store = withStorage();
  SessionsScope.write('all');
  assert.equal(store.get('omni-sessions-scope'), 'all');
  assert.equal(SessionsScope.read(), 'all');
  assert.equal(SessionsScope.toggle('all'), 'current');
  assert.equal(SessionsScope.toggle('current'), 'all');
});

test('localStorage 不可用（隐私模式）时不得抛错，回落当前项目', () => {
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(SessionsScope.read(), 'current');
  SessionsScope.write('all'); // 不抛即通过
});

test('RPC 参数映射：全部 ⇒ `*`；当前项目 ⇒ undefined（服务端缺省即当前项目）', () => {
  assert.equal(SessionsScope.workspaceParam('all'), '*');
  assert.equal(SessionsScope.workspaceParam('current'), undefined);
});
