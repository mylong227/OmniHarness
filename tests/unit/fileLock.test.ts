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
import { FileLock } from '../../src/util/fileLock.js';

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
    const lock = new FileLock(target, { staleMs: 1_000 });
    assert.strictEqual(lock.tryAcquire(), true, '陈旧锁必须可被抢占');
    lock.release();
  });
});

test('未陈旧时不得抢占（保守：不抢活着的进程的锁）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    mkdirSync(`${target}.lock`);
    const lock = new FileLock(target, { staleMs: 60_000 });
    assert.strictEqual(lock.tryAcquire(), false);
  });
});

test('拿不到锁：有界等待后返回 false（降级，不抛错、不无限等）', () => {
  withTemp((dir) => {
    const target = join(dir, 'x.json');
    mkdirSync(`${target}.lock`); // 模拟「活着的持有者」
    const lock = new FileLock(target, { staleMs: 60_000, waitMs: 40, sliceMs: 5 });
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

test('并发写收敛：两个锁轮流执行，10 次读—改—写一次都不丢', () => {
  withTemp((dir) => {
    const target = join(dir, 'counter.json');
    writeFileSync(target, JSON.stringify({ n: 0 }));
    const a = new FileLock(target);
    const b = new FileLock(target);
    for (let i = 0; i < 10; i++) {
      const lock = i % 2 === 0 ? a : b;
      const ok = lock.withLock(() => {
        const cur = JSON.parse(readFileSync(target, 'utf8')) as { n: number };
        writeFileSync(target, JSON.stringify({ n: cur.n + 1 }));
      });
      assert.strictEqual(ok, true, '第 ' + i + ' 轮必须拿到锁');
    }
    const final = JSON.parse(readFileSync(target, 'utf8')) as { n: number };
    assert.strictEqual(final.n, 10, '十次自增必须全部落地（不得丢写入）');
  });
});
