/**
 * 会话公平调度器判据（SFQ）。
 *
 * 关键不是"能并发"，而是**分配**：一个会话灌满队列时，另一个会话的第一个任务不能被拖到
 * 它全部任务之后。旧 `ConcurrencyLimiter` 是 FIFO，这条判据在旧实现上必红。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FairSessionScheduler } from '../../src/util/concurrency/fairSessionScheduler.ts';
import { LockError } from '../../src/util/concurrency/lockError.ts';

/** 可手动兑现的闸门。 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 让已排队的微任务跑完。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('① 全局并发上限：峰值不超过 limit，全部任务最终完成', async () => {
  const gate = deferred();
  const scheduler = new FairSessionScheduler({ limit: 2 });
  const tasks = Array.from({ length: 6 }, (_, i) =>
    scheduler.run(i % 2 === 0 ? 'A' : 'B', async () => {
      await gate.promise;
      return i;
    }),
  );
  await flush();
  assert.strictEqual(scheduler.stats().active, 2);
  assert.strictEqual(scheduler.stats().peakActive, 2);
  gate.resolve();
  assert.deepEqual(
    (await Promise.all(tasks)).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5],
  );
  await flush();
  assert.strictEqual(scheduler.stats().sessions, 0, '空闲会话必须被清理（不无界增长）');
});

test('② 会话公平：A 灌 10 个任务，B/C 的任务不得排在 A 的尾部之后', async () => {
  const order: string[] = [];
  const scheduler = new FairSessionScheduler({ limit: 1 });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const jobs: Promise<void>[] = [];
  jobs.push(
    scheduler.run('A', async () => {
      order.push('A1');
      await firstGate;
    }),
  );
  for (let i = 2; i <= 10; i += 1) {
    jobs.push(
      scheduler
        .run('A', async () => undefined)
        .then(() => {
          order.push(`A${String(i)}`);
        }),
    );
  }
  jobs.push(
    scheduler
      .run('B', async () => undefined)
      .then(() => {
        order.push('B1');
      }),
  );
  jobs.push(
    scheduler
      .run('C', async () => undefined)
      .then(() => {
        order.push('C1');
      }),
  );
  releaseFirst();
  await Promise.all(jobs);
  const b = order.indexOf('B1');
  const c = order.indexOf('C1');
  const a5 = order.indexOf('A5');
  assert.ok(b >= 0 && c >= 0, `B/C 必须完成（order=${order.join(',')}）`);
  assert.ok(b < a5, `B 必须在 A5 之前完成（order=${order.join(',')}）`);
  assert.ok(c < a5, `C 必须在 A5 之前完成（order=${order.join(',')}）`);
});

test('③ 权重：w=3 的会话在持续积压时获得约 3 倍的服务份额', async () => {
  const order: string[] = [];
  const scheduler = new FairSessionScheduler({
    limit: 1,
    weightOf: (sessionId) => (sessionId === 'A' ? 3 : 1),
  });
  const jobs: Promise<void>[] = [];
  for (let i = 1; i <= 30; i += 1) {
    jobs.push(
      scheduler
        .run('A', async () => undefined)
        .then(() => {
          order.push(`A${String(i)}`);
        }),
    );
  }
  for (let i = 1; i <= 10; i += 1) {
    jobs.push(
      scheduler
        .run('B', async () => undefined)
        .then(() => {
          order.push(`B${String(i)}`);
        }),
    );
  }
  await Promise.all(jobs);
  const firstTwenty = order.slice(0, 20);
  const fromA = firstTwenty.filter((name) => name.startsWith('A')).length;
  assert.strictEqual(
    fromA,
    15,
    `w=3:w=1 在前 20 个槽位应约 15:5（实测 ${String(fromA)}:${String(20 - fromA)}；order=${order.slice(0, 20).join(',')}）`,
  );
});

test('④ 队列上限：单会话最多排队 maxQueuePerSession 个，超出立即失败', async () => {
  const gate = deferred();
  const scheduler = new FairSessionScheduler({ limit: 1, maxQueuePerSession: 2 });
  const active = scheduler.run('A', async () => {
    await gate.promise;
  });
  await flush();
  const q1 = scheduler.run('A', async () => undefined);
  const q2 = scheduler.run('A', async () => undefined);
  await assert.rejects(
    () => scheduler.run('A', async () => undefined),
    (error: unknown) =>
      error instanceof LockError &&
      error.code === 'queue-full' &&
      /排队任务已达上限/.test(error.message),
  );
  gate.resolve();
  await Promise.all([active, q1, q2]);
});

test('⑤ 排队取消：AbortSignal 只取消等待者，不影响在跑任务', async () => {
  const gate = deferred();
  const scheduler = new FairSessionScheduler({ limit: 1 });
  let activeFinished = false;
  const active = scheduler.run('A', async () => {
    await gate.promise;
    activeFinished = true;
  });
  await flush();
  const controller = new AbortController();
  const waiting = scheduler.run('B', async () => 'never', { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => waiting,
    (error: unknown) => error instanceof LockError && error.code === 'aborted',
  );
  gate.resolve();
  await active;
  assert.strictEqual(activeFinished, true);
  assert.strictEqual(scheduler.stats().waiting, 0, '取消的等待者不得留在队列');
});

test('⑥ 排队超时：timeoutMs 到点拒绝，已排队任务不泄漏', async () => {
  const gate = deferred();
  const scheduler = new FairSessionScheduler({ limit: 1 });
  const active = scheduler.run('A', async () => {
    await gate.promise;
  });
  await flush();
  const waiting = scheduler.run('B', async () => 'never', { timeoutMs: 20 });
  await assert.rejects(
    () => waiting,
    (error: unknown) => error instanceof LockError && error.code === 'timeout',
  );
  gate.resolve();
  await active;
  assert.strictEqual(scheduler.stats().waiting, 0);
});

test('⑦ 已在执行的任务不受排队取消影响（信号由任务自己观察）', async () => {
  const controller = new AbortController();
  const scheduler = new FairSessionScheduler({ limit: 1 });
  const gate = deferred();
  const running = scheduler.run(
    'A',
    async () => {
      await gate.promise;
      return 'done';
    },
    { signal: controller.signal },
  );
  await flush();
  controller.abort();
  gate.resolve();
  assert.strictEqual(await running, 'done', '已调度的任务不能被调度器单方面取消');
});

test('⑧ 权重下限：非法/极端权重被钳制，不会饿死其他会话', async () => {
  const order: string[] = [];
  const scheduler = new FairSessionScheduler({
    limit: 1,
    weightOf: (sessionId) => (sessionId === 'A' ? Number.POSITIVE_INFINITY : Number.NaN),
  });
  const jobs: Promise<void>[] = [];
  for (let i = 1; i <= 2; i += 1) {
    jobs.push(
      scheduler
        .run('A', async () => undefined)
        .then(() => {
          order.push(`A${String(i)}`);
        }),
    );
    jobs.push(
      scheduler
        .run('B', async () => undefined)
        .then(() => {
          order.push(`B${String(i)}`);
        }),
    );
  }
  await Promise.all(jobs);
  assert.strictEqual(order.includes('B1'), true, `B 必须得到服务（order=${order.join(',')}）`);
});
