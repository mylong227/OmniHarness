/**
 * ParallelMap 单测：有界并发 / 同序保证 / 均衡调度（快任务不被慢任务阻塞）/ 串行等价。
 *
 * 断言口径：
 *  - 在飞任务峰值 == concurrency（且恒不超过）；
 *  - 结果与输入严格同序（即使完成顺序被打乱）；
 *  - 均衡：并发 > 1 的墙钟显著低于串行墙钟；
 *  - concurrency=1 与朴素 for-await 等价；非法值归一化为 1。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParallelMap } from '../../src/util/parallelMap.js';

/** 睡眠（模拟 I/O 密集任务）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrency 归一化：0/NaN/2.7 分别 → 1/1/2', () => {
  assert.strictEqual(new ParallelMap(0).concurrency(), 1);
  assert.strictEqual(new ParallelMap(Number.NaN).concurrency(), 1);
  assert.strictEqual(new ParallelMap(2.7).concurrency(), 2);
  assert.strictEqual(new ParallelMap(4).concurrency(), 4);
});

test('空输入返回空数组', async () => {
  const out = await new ParallelMap(4).map([], (x: number) => Promise.resolve(x * 2));
  assert.deepEqual(out, []);
});

test('结果与输入严格同序（完成顺序被打乱也不乱序）', async () => {
  // 故意让「越靠前越慢」，制造与完成顺序相反的乱序，验证按输入下标回填。
  const delays = [60, 40, 20, 5];
  const out = await new ParallelMap(4).map(delays, async (ms, i) => {
    await sleep(ms);
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test('在飞任务峰值 == 并发上限（有界验证）', async () => {
  const limit = 3;
  let inFlight = 0;
  let peak = 0;
  const out = await new ParallelMap(limit).map(
    [10, 10, 10, 10, 10, 10, 10, 10, 10],
    async (ms, i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight -= 1;
      return i;
    },
  );
  assert.strictEqual(peak, limit);
  assert.strictEqual(out.length, 9);
});

test('均衡调度：并发 4 的墙钟显著低于串行（快任务不被慢任务阻塞）', async () => {
  const items = [50, 50, 50, 50, 50, 50, 50, 50];
  const t0 = Date.now();
  await new ParallelMap(1).map(items, (ms) => sleep(ms));
  const serial = Date.now() - t0;

  const t1 = Date.now();
  await new ParallelMap(4).map(items, (ms) => sleep(ms));
  const parallel = Date.now() - t1;

  // 串行 ≈ 400ms；并发 4 ≈ 100ms。给足余量断言并发快至少 2 倍。
  assert.ok(parallel * 2 < serial, `期望并发显著更快：serial=${serial}ms parallel=${parallel}ms`);
});

test('concurrency=1 退化为严格串行（不重叠）', async () => {
  let inFlight = 0;
  let peak = 0;
  await new ParallelMap(1).map([5, 5, 5], async (ms) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(ms);
    inFlight -= 1;
  });
  assert.strictEqual(peak, 1);
});
