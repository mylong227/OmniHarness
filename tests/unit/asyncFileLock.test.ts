/**
 * `AsyncFileLock` 判据：异步等待不阻塞事件循环、租约心跳不被误接管、自定义锁目录不污染工作区。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncFileLock } from '../../src/util/concurrency/asyncFileLock.ts';

/** 在临时目录内执行。 */
function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'async-file-lock-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('① 自定义锁目录：锁不落在目标文件旁边', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'x');
    const lockDir = join(dir, '.omniharness', 'locks', 'key');
    const lock = new AsyncFileLock(target, { lockDir, waitMs: 100, leaseMs: 1_000 });
    assert.strictEqual(await lock.acquire(), true);
    assert.strictEqual(existsSync(lockDir), true, '自定义锁目录应被使用');
    assert.strictEqual(existsSync(`${target}.lock`), false, '不得污染目标文件目录');
    lock.release();
    assert.strictEqual(existsSync(lockDir), false);
  });
});

test('② 异步等待有界：持有期间第二个实例拿不到，且不永久挂起', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'x');
    const a = new AsyncFileLock(target, { waitMs: 100, leaseMs: 1_000 });
    assert.strictEqual(await a.acquire(), true);
    const b = new AsyncFileLock(target, { waitMs: 60, leaseMs: 1_000 });
    const started = Date.now();
    assert.strictEqual(await b.acquire(), false, '持有期间第二个实例必须超时失败');
    assert.ok(Date.now() - started < 2_000, '等待必须有界');
    assert.ok(b.holder() !== undefined, '拿不到锁时应能读到持有者（用于可行动文案）');
    a.release();
    assert.strictEqual(await b.acquire(), true, '释放后应能立即拿到');
    b.release();
  });
});

test('③ 租约心跳：临界区超过 leaseMs 仍不会被误判陈旧接管', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'x');
    const long = new AsyncFileLock(target, { waitMs: 100, leaseMs: 300, sliceMs: 3 });
    assert.strictEqual(await long.acquire(), true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const contender = new AsyncFileLock(target, { waitMs: 30, leaseMs: 300 });
    assert.strictEqual(
      await contender.acquire(),
      false,
      '心跳应持续续租；超过一个 lease 后仍不得被接管',
    );
    long.release();
    assert.strictEqual(await contender.acquire(), true);
    contender.release();
  });
});

test('④ 取消信号：等待中取消立即返回 false', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'x');
    const holder = new AsyncFileLock(target, { waitMs: 100, leaseMs: 1_000 });
    assert.strictEqual(await holder.acquire(), true);
    const controller = new AbortController();
    const waiter = new AsyncFileLock(target, { waitMs: 5_000, leaseMs: 1_000 });
    const pending = waiter.acquire(controller.signal);
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    assert.strictEqual(await pending, false);
    assert.ok(Date.now() - started < 2_000, '取消不得等到完整 waitMs');
    holder.release();
  });
});
