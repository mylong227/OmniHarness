import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CancellationToken,
  CancelledError,
} from '../../src/core/loop/cancellation.js';

test('取消令牌：cancel 幂等，首次 reason 生效', () => {
  const token = new CancellationToken();
  assert.strictEqual(token.isCancelled, false);
  token.cancel('user');
  token.cancel('timeout');
  assert.strictEqual(token.isCancelled, true);
  assert.strictEqual(token.cancelReason, 'user');
});

test('取消令牌：throwIfAborted 未取消不抛 / 取消抛 CancelledError', () => {
  const token = new CancellationToken();
  token.throwIfAborted(); // 不抛
  token.cancel({ custom: '测试原因' });
  assert.throws(() => token.throwIfAborted(), CancelledError);
});

test('取消令牌：listen 注册回调并收到 reason，可解绑', () => {
  const token = new CancellationToken();
  const seen: unknown[] = [];
  const unbind = token.listen((reason) => seen.push(reason));
  token.cancel('timeout');
  assert.deepStrictEqual(seen, ['timeout']);
  // 取消后 listen 立即触发
  const late: unknown[] = [];
  token.listen((reason) => late.push(reason));
  assert.deepStrictEqual(late, ['timeout']);
  unbind();
});

test('取消令牌：子令牌级联取消，子取消不影响父', () => {
  const parent = new CancellationToken();
  const child = parent.child();
  child.cancel('user');
  assert.strictEqual(parent.isCancelled, false);
  assert.strictEqual(child.isCancelled, true);

  const parent2 = new CancellationToken();
  const child2 = parent2.child();
  parent2.cancel('shutdown');
  assert.strictEqual(child2.isCancelled, true);
  assert.strictEqual(child2.cancelReason, 'parent');
});

test('取消令牌：race 与取消竞速，取消即抛', async () => {
  const token = new CancellationToken();
  const never = new Promise<string>(() => {});
  const losing = token.race(never);
  token.cancel('user');
  await assert.rejects(losing, CancelledError);

  // 正常完成路径：promise 先到则正常 resolve
  const token2 = new CancellationToken();
  const value = await token2.race(Promise.resolve('ok'));
  assert.strictEqual(value, 'ok');
});

test('取消令牌：toAbortSignal 桥接标准 AbortSignal', () => {
  const token = new CancellationToken();
  const signal = token.toAbortSignal();
  assert.strictEqual(signal.aborted, false);
  token.cancel('user');
  assert.strictEqual(signal.aborted, true);

  // 已取消令牌的 signal 直接是 aborted
  const done = new CancellationToken();
  done.cancel('timeout');
  assert.strictEqual(done.toAbortSignal().aborted, true);
});
