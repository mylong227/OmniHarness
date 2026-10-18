// 会话显示范围（当前项目 / 全部项目）的本机偏好：解析、写回、翻转、RPC 参数映射。
//
// 为什么把它单独测：这个开关就是"我的项目数据去哪了"的答案——存档在全局目录、按项目标记归属，
// 缺省只显示当前项目（防淹没），但**必须**能一键看到全部。偏好读写出错时不得影响功能，
// 故非法值/隐私模式一律回落 `current`。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SessionsScope } from '../src/ui/models/SessionsScope.ts';

/**
 * 装一个最小 localStorage（Node 无 DOM）。
 * @param initial 初始键值对
 * @returns 底层存储 Map
 */
function withStorage(initial?: Record<string, string>) {
  const store = new Map(Object.entries(initial ?? {}));
  // 桩只实现 SessionsScope 用到的 getItem / setItem，其余 Storage 成员不被触碰；
  // 在「测试桩与被测代码的调用边界」按 Storage 收窄（规则允许的例外 a）。
  globalThis.localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) ?? null) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  } as unknown as Storage;
  return store;
}

test('缺省/非法值一律回落「当前项目」（fail-safe 默认）', () => {
  withStorage();
  assert.strictEqual(SessionsScope.read(), 'current');
  withStorage({ 'omni-sessions-scope': 'bogus' });
  assert.strictEqual(SessionsScope.read(), 'current');
  withStorage({ 'omni-sessions-scope': 'all' });
  assert.strictEqual(SessionsScope.read(), 'all');
});

test('写回 → 读回一致；翻转在两个模式间来回', () => {
  const store = withStorage();
  SessionsScope.write('all');
  assert.strictEqual(store.get('omni-sessions-scope'), 'all');
  assert.strictEqual(SessionsScope.read(), 'all');
  assert.strictEqual(SessionsScope.toggle('all'), 'current');
  assert.strictEqual(SessionsScope.toggle('current'), 'all');
});

test('localStorage 不可用（隐私模式）时不得抛错，回落当前项目', () => {
  // 同上：只给 SessionsScope 实际会碰到的方法，其余 Storage 成员按边界口径收窄
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  } as unknown as Storage;
  assert.strictEqual(SessionsScope.read(), 'current');
  SessionsScope.write('all'); // 不抛即通过
});

test('RPC 参数映射：全部 ⇒ `*`；当前项目 ⇒ undefined（服务端缺省即当前项目）', () => {
  assert.strictEqual(SessionsScope.workspaceParam('all'), '*');
  assert.strictEqual(SessionsScope.workspaceParam('current'), undefined);
});
