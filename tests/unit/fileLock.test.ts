// 跨进程文件锁门禁（真文件、真 IO）：用户要求收掉「有界重试会放弃最后一次写入」这条边界。
//
// 锁 = `mkdir` 出来的目录（Windows/POSIX 都是原子创建、已存在即失败）。判据：
// ① 持锁期间别人抢不到；② 释放后能抢到；③ 临界区抛错也释放（否则一次异常锁死侧车写入）；
// ④ 陈旧锁可被抢占（持有者崩了不能永久卡死）；⑤ 拿不到锁时 `withLock` 返回 false（**降级而不抛错**）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLock } from '../../src/util/concurrency/fileLock.js';

/** 在临时目录内执行。 */
function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('互斥：持有期间别人抢不到，释放后可抢', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    const a = new FileLock(target);
    const b = new FileLock(target);
    assert.strictEqual(a.tryAcquire(), true);
    assert.strictEqual(b.tryAcquire(), false, '同一把锁不得被两个持有者同时拿到');
    a.release();
    assert.strictEqual(b.tryAcquire(), true);
    b.release();
    assert.strictEqual(existsSync(`${target}.lock`), false, '释放必须清掉锁目录');
  });
});

test('临界区抛错也必须释放（否则一次异常永久锁死写入）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    const lock = new FileLock(target);
    assert.throws(() =>
      lock.withLock(() => {
        throw new Error('boom');
      }),
    );
    assert.strictEqual(existsSync(`${target}.lock`), false);
    assert.strictEqual(new FileLock(target).tryAcquire(), true, '异常后必须仍能抢到锁');
  });
});

test('陈旧锁可被抢占（持有者崩溃不得永久卡死）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    // 造一个「别的进程崩在临界区」留下的锁：手建锁目录并把 mtime 调到很久以前
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const lock = new FileLock(target, { leaseMs: 1_000 });
    assert.strictEqual(lock.tryAcquire(), true, '陈旧锁必须可被抢占');
    lock.release();
  });
});

test('未陈旧时不得抢占（保守：不抢活着的进程的锁）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    mkdirSync(`${target}.lock`);
    const lock = new FileLock(target, { leaseMs: 60_000 });
    assert.strictEqual(lock.tryAcquire(), false);
  });
});

test('拿不到锁：有界等待后返回 false（降级，不抛错、不无限等）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    mkdirSync(`${target}.lock`); // 模拟「活着的持有者」
    const lock = new FileLock(target, { leaseMs: 60_000, waitMs: 40, sliceMs: 5 });
    const started = Date.now();
    let ran = false;
    const ok = lock.withLock(() => {
      ran = true;
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(ok, false, '拿不到锁必须返回 false 让调用方降级');
    assert.strictEqual(ran, false, '不得在没拿到锁的情况下执行临界区');
    assert.ok(elapsed < 2_000, `等待必须有界（实测 ${elapsed}ms）`);
  });
});

test('租约过期可按 token 接管：接管者 token 递增（fencing token 单调）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    const first = new FileLock(target, { leaseMs: 1_000 });
    assert.strictEqual(first.tryAcquire(), true);
    const token1 = readTokenOf(target);
    // 让租约过期（持有者「崩了」：不释放、也不再刷新）
    const ownerFile = `${target}.lock/owner.json`;
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { token: number; at: number };
    writeFileSync(ownerFile, JSON.stringify({ ...owner, at: Date.now() - 60_000 }));
    const second = new FileLock(target, { leaseMs: 1_000 });
    assert.strictEqual(second.tryAcquire(), true, '租约过期必须可被接管');
    const token2 = readTokenOf(target);
    assert.ok(token2 > token1, `token 必须递增（实测 ${token1} → ${token2}）`);
    second.release();
  });
});

test('fencing：临界区内被接管 ⇒ guard 抛错、写入放弃（onCompromised 语义）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    const ownerFile = `${target}.lock/owner.json`;
    const victim = new FileLock(target, { leaseMs: 1_000, waitMs: 20 });
    // 注意：FileLock **不可重入**（同名锁不能自己再拿一次），所以要在这里一次性演示：
    // withLock 先拿到锁 → 临界区内租约到期、被另一进程接管 → 写盘前的 guard 必须抛错。
    assert.throws(
      () =>
        victim.withLock((guard) => {
          const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as {
            token: number;
            at: number;
          };
          writeFileSync(ownerFile, JSON.stringify({ ...owner, at: Date.now() - 60_000 }));
          assert.strictEqual(
            new FileLock(target, { leaseMs: 1_000 }).tryAcquire(),
            true,
            '租约过期后另一个进程必须能接管',
          );
          guard(); // ← 必须在此发现锁已不属于自己
        }),
      /已被接管/,
    );
    // 被接管后单独调 assertHeld 同样抛错（不依赖临界区上下文）
    assert.throws(() => victim.assertHeld(), /已被接管/);
  });
});

test('被接管后释放：**不得删除别人的锁**（只放弃本地 token）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    const victim = new FileLock(target, { leaseMs: 1_000 });
    assert.strictEqual(victim.tryAcquire(), true);
    const ownerFile = `${target}.lock/owner.json`;
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { token: number; at: number };
    writeFileSync(ownerFile, JSON.stringify({ ...owner, at: Date.now() - 60_000 }));
    const thief = new FileLock(target, { leaseMs: 1_000 });
    assert.strictEqual(thief.tryAcquire(), true);
    victim.release();
    assert.strictEqual(existsSync(`${target}.lock`), true, '原持有者不得删掉接管者的锁');
    assert.strictEqual(thief.tryAcquire(), false, '接管者的锁仍应有效');
    thief.release();
  });
});

test('并发写收敛：两个锁轮流执行，10 次读—改—写一次都不丢', () => {
  withTemp((dir) => {
    const target = join(dir, 'counter.json');
    writeFileSync(target, JSON.stringify({ n: 0 }));
    const a = new FileLock(target);
    const b = new FileLock(target);
    for (let i = 0; i < 10; i++) {
      const lock = i % 2 === 0 ? a : b;
      const ok = lock.withLock((guard) => {
        const cur = JSON.parse(readFileSync(target, 'utf8')) as { n: number };
        guard();
        writeFileSync(target, JSON.stringify({ n: cur.n + 1 }));
      });
      assert.strictEqual(ok, true, '第 ' + i + ' 轮必须拿到锁');
    }
    const final = JSON.parse(readFileSync(target, 'utf8')) as { n: number };
    assert.strictEqual(final.n, 10, '十次自增必须全部落地（不得丢写入）');
  });
});

/** 读锁目录里的 token。 */
function readTokenOf(target: string): number {
  const owner = JSON.parse(readFileSync(`${target}.lock/owner.json`, 'utf8')) as { token: number };
  return owner.token;
}
