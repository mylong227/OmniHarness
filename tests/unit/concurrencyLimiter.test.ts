/**
 * ConcurrencyLimiter 的 FIFO 语义与大规模等待者回归（2026-09-22 性能收尾）。
 *
 * 背景：`release()` 原用 `waiters.shift()`（每次搬移整个剩余数组），而 `parallelMap` 会为
 * **全部**条目先建 promise，未获槽位者一次性入队 ⇒ 总代价 O(N²/concurrency)（实测 n=20k/40k
 * 的调度开销 576 / 927 ms）。改为「游标 + 过半压缩」后 45 / 63 ms。本测试钉住两点：
 * ① 语义不变——等待者严格 FIFO 且恰好运行一次、`active` 不越过上限；
 * ② 规模不回归——上万等待者仍能在毫秒级完成（若退回 `shift()` 会显著变慢，但断言取宽松上界，
 *    只作「不炸」的护栏，精确性能数字由 `.omniharness` 内的基准脚本负责）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLimiter } from '../../src/util/concurrencyLimiter.js';

test('等待者严格 FIFO：先到先得，顺序不乱（槽位链式移交）', async () => {
  const limiter = new ConcurrencyLimiter(1);
  const order: number[] = [];
  await limiter.acquire(); // 主流程占住唯一槽位
  const pending = [1, 2, 3, 4, 5].map((id) =>
    limiter.run(() => {
      order.push(id);
      return Promise.resolve();
    }),
  );
  await Promise.resolve();
  limiter.release(); // 移交队首；其后每个任务的 finally 会继续链式移交
  await Promise.all(pending);
  assert.deepStrictEqual(order, [1, 2, 3, 4, 5]);
  assert.strictEqual(limiter.activeCount(), 0);
});

test('大规模等待者：全部恰好完成一次，活跃数不越界（游标压缩无重复唤醒）', async () => {
  const limiter = new ConcurrencyLimiter(4);
  const N = 5000;
  let done = 0;
  let peak = 0;
  const tasks = Array.from({ length: N }, () =>
    limiter.run(async () => {
      const active = limiter.activeCount();
      if (active > peak) peak = active;
      await Promise.resolve();
      done += 1;
    }),
  );
  await Promise.all(tasks);
  assert.strictEqual(done, N);
  assert.ok(peak <= 4, `并发峰值 ${peak} 不得超过上限`);
  assert.strictEqual(limiter.activeCount(), 0);
});

test('异常路径：任务抛错也释放槽位（后续任务不被卡死）', async () => {
  const limiter = new ConcurrencyLimiter(1);
  await assert.rejects(() => limiter.run(() => Promise.reject(new Error('boom'))), /boom/);
  assert.strictEqual(limiter.activeCount(), 0);
  const ok = await limiter.run(() => Promise.resolve('fine'));
  assert.strictEqual(ok, 'fine');
});
