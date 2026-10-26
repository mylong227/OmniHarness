/**
 * 键控读写锁判据：读读并行、写写互斥、写者优先（不饿死写者）、FIFO、取消/超时、空闲清理。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { KeyedReadWriteLock } from '../../src/util/concurrency/keyedReadWriteLock.ts';
import { LockError } from '../../src/util/concurrency/lockError.ts';

/** 让已排队的微任务跑完。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('① 读读并行：多个读者可同时持有同一 key', async () => {
  const lock = new KeyedReadWriteLock();
  const a = await lock.acquireRead('k');
  const b = await lock.acquireRead('k');
  assert.strictEqual(lock.stats().readers, 2);
  a();
  assert.strictEqual(lock.stats().readers, 1);
  b();
  assert.strictEqual(lock.stats().keys, 0, '空闲后必须清理 key');
});

test('② 写写互斥 + 写者优先：排队的写者先于后到的读者', async () => {
  const lock = new KeyedReadWriteLock();
  const read = await lock.acquireRead('k');
  const order: string[] = [];
  const writer = lock.acquireWrite('k').then((release) => {
    order.push('writer');
    return release;
  });
  const reader = lock.acquireRead('k').then((release) => {
    order.push('reader');
    return release;
  });
  await flush();
  assert.deepEqual(order, [], '读者/写者都必须等当前读者释放');
  read();
  const writerRelease = await writer;
  assert.deepEqual(order, ['writer'], '写者必须优先，不能被后到的读者插队');
  writerRelease();
  const readerRelease = await reader;
  assert.deepEqual(order, ['writer', 'reader']);
  readerRelease();
  assert.strictEqual(lock.stats().keys, 0);
});

test('③ 写者 FIFO：先排队的写者先拿到，不会被后来者插队', async () => {
  const lock = new KeyedReadWriteLock();
  const read = await lock.acquireRead('k');
  const order: number[] = [];
  const first = lock.acquireWrite('k').then((release) => {
    order.push(1);
    return release;
  });
  const second = lock.acquireWrite('k').then((release) => {
    order.push(2);
    return release;
  });
  read();
  const firstRelease = await first;
  await flush();
  assert.deepEqual(order, [1], '第二个写者不得与第一个重叠');
  firstRelease();
  const secondRelease = await second;
  assert.deepEqual(order, [1, 2]);
  secondRelease();
});

test('④ 写者等待期间，后到的读者不得插队（避免写者饥饿）', async () => {
  const lock = new KeyedReadWriteLock();
  const readA = await lock.acquireRead('k');
  const order: string[] = [];
  const writer = lock.acquireWrite('k').then((release) => {
    order.push('w');
    return release;
  });
  const readB = lock.acquireRead('k').then((release) => {
    order.push('r2');
    return release;
  });
  const readC = lock.acquireRead('k').then((release) => {
    order.push('r3');
    return release;
  });
  readA();
  const writerRelease = await writer;
  assert.deepEqual(order, ['w']);
  writerRelease();
  const [b, c] = await Promise.all([readB, readC]);
  assert.deepEqual(order, ['w', 'r2', 'r3']);
  b();
  c();
});

test('⑤ 等待取消：AbortSignal 触发后拒绝且不泄漏队列', async () => {
  const lock = new KeyedReadWriteLock();
  const held = await lock.acquireWrite('k');
  const controller = new AbortController();
  const waiting = lock.acquireRead('k', { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => waiting,
    (error: unknown) => error instanceof LockError && error.code === 'aborted',
  );
  assert.strictEqual(lock.stats().waiters, 0);
  held();
  assert.strictEqual(lock.stats().keys, 0);
});

test('⑥ 等待超时：timeoutMs 到点拒绝，已持有的锁不受影响', async () => {
  const lock = new KeyedReadWriteLock();
  const held = await lock.acquireWrite('k');
  await assert.rejects(
    () => lock.acquireRead('k', { timeoutMs: 20 }),
    (error: unknown) => error instanceof LockError && error.code === 'timeout',
  );
  assert.strictEqual(lock.stats().waiters, 0);
  held();
  assert.strictEqual(lock.stats().keys, 0);
});

test('⑦ 不同 key 互不影响（不同文件可并行）', async () => {
  const lock = new KeyedReadWriteLock();
  const a = await lock.acquireWrite('a');
  const b = await lock.acquireWrite('b');
  assert.strictEqual(lock.stats().writers, 2);
  a();
  b();
  assert.strictEqual(lock.stats().keys, 0);
});

test('⑧ 释放幂等：重复调用不会多减读者计数', async () => {
  const lock = new KeyedReadWriteLock();
  const release = await lock.acquireRead('k');
  release();
  release();
  assert.strictEqual(lock.stats().readers, 0);
  assert.strictEqual(lock.stats().keys, 0);
});
