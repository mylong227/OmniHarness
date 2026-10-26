/**
 * 并发性质测试（确定性随机种子，不赌时序）。
 *
 * 这些判据不只测「某个 bug 修好了」，而是测**代数/不变量性质**：
 * - 读写锁：任意交错下 `W≤1` 且 `W>0 ⇒ R=0`；
 * - SFQ：持续积压时各会话服务量按权重成比例（1:2:3）；
 * - 协调器：多个会话的读—改—写在进程内也不丢写。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyedReadWriteLock } from '../../src/util/concurrency/keyedReadWriteLock.ts';
import { FairSessionScheduler } from '../../src/util/concurrency/fairSessionScheduler.ts';
import { WorkspaceFileCoordinator } from '../../src/adapters/tool/fs/workspaceFileCoordinator.ts';

/** 线性同余伪随机（固定种子，跨平台确定）。 */
class Lcg {
  /** 当前状态。 */
  private state: number;

  /**
   * @param seed 种子。
   */
  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /**
   * 下一个 [0,1) 浮点。
   * @returns 伪随机数。
   */
  public next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  /**
   * 下一个 [0,max) 整数。
   * @param max 上界（不含）。
   * @returns 整数。
   */
  public int(max: number): number {
    return Math.floor(this.next() * max);
  }
}

test('① 读写锁不变量：200 个随机读写任务交错，W≤1 且写者独占', async () => {
  const lock = new KeyedReadWriteLock();
  const rng = new Lcg(20_261_025);
  let readers = 0;
  let writers = 0;
  const tasks = Array.from({ length: 200 }, async () => {
    const mode = rng.next() < 0.6 ? 'read' : 'write';
    const release =
      mode === 'read' ? await lock.acquireRead('shared') : await lock.acquireWrite('shared');
    if (mode === 'read') readers += 1;
    else writers += 1;
    assert.ok(writers <= 1, `写者数不得超过 1（实测 ${String(writers)}）`);
    assert.ok(
      !(writers > 0 && readers > 0),
      `写者与读者不得同时持有（R=${String(readers)} W=${String(writers)}）`,
    );
    await new Promise((resolve) => setTimeout(resolve, rng.int(3)));
    if (mode === 'read') readers -= 1;
    else writers -= 1;
    release();
  });
  await Promise.all(tasks);
  assert.strictEqual(readers, 0);
  assert.strictEqual(writers, 0);
  assert.strictEqual(lock.stats().keys, 0);
});

test('② SFQ 权重性质：积压时前 60 个槽位按 1:2:3 分配', async () => {
  const order: string[] = [];
  const scheduler = new FairSessionScheduler({
    limit: 1,
    maxQueuePerSession: 400,
    maxQueueTotal: 1_000,
    weightOf: (sessionId) => (sessionId === 'A' ? 1 : sessionId === 'B' ? 2 : 3),
  });
  const jobs: Promise<void>[] = [];
  const enqueue = (session: string, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      jobs.push(
        scheduler
          .run(session, async () => undefined)
          .then(() => {
            order.push(session);
          }),
      );
    }
  };
  enqueue('A', 100);
  enqueue('B', 200);
  enqueue('C', 300);
  await Promise.all(jobs);
  const first = order.slice(0, 60);
  assert.strictEqual(first.filter((s) => s === 'A').length, 10);
  assert.strictEqual(first.filter((s) => s === 'B').length, 20);
  assert.strictEqual(first.filter((s) => s === 'C').length, 30);
});

test('③ 协调器：6 个会话各 20 次读—改—写，120 次自增一次不丢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-props-'));
  try {
    const file = join(dir, 'counter.json');
    await writeFile(file, JSON.stringify({ n: 0 }), 'utf8');
    const coordinator = WorkspaceFileCoordinator.of(dir);
    const rng = new Lcg(7);
    const worker = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await coordinator.withWrite(file, async (lease) => {
          const current = JSON.parse((await lease.read()) ?? '{"n":0}') as { n: number };
          await new Promise((resolve) => setTimeout(resolve, rng.int(2)));
          await lease.write(JSON.stringify({ n: current.n + 1 }));
        });
      }
    };
    await Promise.all(Array.from({ length: 6 }, () => worker()));
    const final = JSON.parse(await readFile(file, 'utf8')) as { n: number };
    assert.strictEqual(final.n, 120, `120 次自增必须全部落地（实测 ${String(final.n)}）`);
  } finally {
    WorkspaceFileCoordinator.forget(dir);
    await rm(dir, { recursive: true, force: true });
  }
});
