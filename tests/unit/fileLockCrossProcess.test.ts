// **真·跨进程**锁门禁（用户要求「按真实的完成」）：不是同进程里造两个 FileLock 实例，
// 而是 `spawn` **两个真的 Node 子进程**去争同一把锁，验证「并发读—改—写一次都不丢」。
//
// 为什么这样写：
// - 子进程用 `--input-type=module -e`，直接 import 编译产物里的 `FileLock`（跑的是同一份实现）；
// - **不使用管道**（`stdio: 'ignore'`）：结果通过**文件**传递，避免把「管道/沙箱」问题混进被测语义；
// - 两个子进程同时启动、各自「拿锁 → 读计数 → +1 → 写回 → 释放」，父进程等两者退出后断言计数 = 2。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** 编译产物里的 fileLock 模块 URL（子进程 import 用）。 */
const LOCK_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'util', 'fileLock.js'),
).href;

/**
 * 启动一个「抢锁 → 计数 +1」的子进程。
 * @param counter 计数文件路径
 * @param holdMs 临界区里额外停留的毫秒数（放大交错窗口）
 * @returns 子进程退出码的 Promise
 */
function spawnIncrementer(counter: string, holdMs: number): Promise<number> {
  const script = `
import { FileLock } from ${JSON.stringify(LOCK_URL)};
import { readFileSync, writeFileSync } from 'node:fs';
const counter = ${JSON.stringify(counter)};
const lock = new FileLock(counter, { waitMs: 10_000, leaseMs: 30_000, sliceMs: 3 });
const ok = lock.withLock((guard) => {
  const cur = JSON.parse(readFileSync(counter, 'utf8')).n;
  const until = Date.now() + ${holdMs};
  while (Date.now() < until) { /* 放大临界区，逼出交错 */ }
  guard();
  writeFileSync(counter, JSON.stringify({ n: cur + 1 }));
});
process.exit(ok ? 0 : 2);
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

test('真·跨进程：两个 Node 进程争同一把锁，10 次自增一次不丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-lock-xproc-'));
  try {
    const counter = join(dir, 'counter.json');
    writeFileSync(counter, JSON.stringify({ n: 0 }));
    for (let round = 0; round < 5; round++) {
      const codes = await Promise.all([
        spawnIncrementer(counter, 25),
        spawnIncrementer(counter, 25),
      ]);
      assert.deepEqual(
        codes,
        [0, 0],
        `第 ${round} 轮两个子进程都必须成功拿锁并写入（实测退出码 ${JSON.stringify(codes)}）`,
      );
    }
    const final = JSON.parse(readFileSync(counter, 'utf8')) as { n: number };
    assert.strictEqual(final.n, 10, `十次跨进程自增必须全部落地（实测 ${final.n}）`);
    assert.strictEqual(existsSync(`${counter}.lock`), false, '收尾不得留下锁目录');
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.includes('.tmp')),
      [],
      '不得留下临时文件',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真·跨进程：拿不到锁的子进程**有界退出**（不无限等、不写坏文件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-lock-xproc-busy-'));
  try {
    const counter = join(dir, 'counter.json');
    writeFileSync(counter, JSON.stringify({ n: 0 }));
    // 先由父进程持锁（模拟「另一个进程正在临界区里」）
    const { FileLock } = await import('../../src/util/fileLock.js');
    const held = new FileLock(counter, { leaseMs: 30_000 });
    assert.strictEqual(held.tryAcquire(), true);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { FileLock } from ${JSON.stringify(LOCK_URL)};
const lock = new FileLock(${JSON.stringify(counter)}, { waitMs: 120, sliceMs: 5, leaseMs: 30_000 });
process.exit(lock.withLock(() => {}) ? 0 : 3);
`,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? -1)));
    assert.strictEqual(code, 3, '抢不到锁必须以非 0 退出并让调用方降级（不得无限等）');
    assert.strictEqual(
      JSON.parse(readFileSync(counter, 'utf8')).n,
      0,
      '拿不到锁的子进程不得改动文件',
    );
    held.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
