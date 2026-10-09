/**
 * 工作流运行锁（跨进程互斥）判据（2026-10-08）。
 *
 * ## 为什么必须真跨进程验一次
 *
 * 这条锁要挡的正是「两个 CLI 进程同时对同一 runId 续跑」——而**同进程内的二次 acquire 只能证明
 * 文件创建语义**（`wx` 独占），证明不了「另一个活着的进程会挡住我」。故这里起一个**真子进程**持锁，
 * 由父进程尝试加锁：必须被拒；子进程退出后（锁没被释放 = 模拟被 kill）父进程必须能**自动接管**
 * ——这一条同时钉住「崩溃后不能永久锁死」，而那正是续跑功能的初衷。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowRunLock } from '../../src/autonomy/workflowRunLock.js';
import { WorkflowSpecError } from '../../src/autonomy/workflowSpecError.js';

/** 被测锁模块的绝对 file URL（供子进程 import）。 */
const LOCK_MODULE_URL = pathToFileURL(
  join(process.cwd(), 'dist', 'src', 'autonomy', 'workflowRunLock.js'),
).href;

/**
 * 在临时工作区里跑一段用例。
 * @param run 用例体（收到临时目录）
 * @returns 无返回值
 */
function withWorkspace(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'workflow-lock-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 找一个**确定已死**的 PID：起一个立即退出的子进程，取它的 pid。
 * @returns 已不存在的进程 id
 */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '0'], { stdio: ['ignore', 'ignore', 'ignore'] });
  assert.ok(typeof child.pid === 'number' && child.pid > 0, '未能取得子进程 pid');
  return child.pid;
}

test('WorkflowRunLock：加锁后被第二次 acquire 拒绝（含持锁 pid/host 提示），release 后放行', () => {
  withWorkspace((root) => {
    const lock = new WorkflowRunLock(root);
    const info = lock.acquire('run_lock_1');
    assert.strictEqual(info.pid, process.pid);
    assert.ok(lock.isHeld('run_lock_1'), '持有中应报告 held');

    assert.throws(
      () => new WorkflowRunLock(root).acquire('run_lock_1'),
      (error) => {
        assert.ok(error instanceof WorkflowSpecError);
        assert.match(error.message, /正被另一进程续跑/);
        assert.match(error.message, new RegExp(`pid=${process.pid}`), '必须报出持锁 pid 便于排查');
        return true;
      },
    );

    lock.release('run_lock_1');
    assert.strictEqual(lock.isHeld('run_lock_1'), false);
    // 释放后可再次加锁（同一 runId 反复续跑是正常路径）。
    assert.doesNotThrow(() => lock.acquire('run_lock_1'));
    lock.release('run_lock_1');
    assert.strictEqual(existsSync(lock.pathOf('run_lock_1')), false, '释放后锁文件必须消失');
  });
});

test('WorkflowRunLock：持锁进程已死 ⇒ 立即接管（崩溃一次不得永久锁死）', () => {
  withWorkspace((root) => {
    const lock = new WorkflowRunLock(root);
    // 手工写一份「死者的锁」：同主机 + 已不存在的 PID。
    const path = lock.pathOf('run_dead_1');
    lock.acquire('run_dead_1'); // 先建目录
    writeFileSync(
      path,
      `${JSON.stringify({ pid: deadPid(), host: hostname(), at: new Date(0).toISOString(), runId: 'run_dead_1' })}\n`,
      'utf8',
    );
    const taken = lock.acquire('run_dead_1');
    assert.strictEqual(taken.pid, process.pid, '死者的锁必须被接管');
    lock.release('run_dead_1');
  });
});

test('WorkflowRunLock：跨主机的锁不能被 PID 判活（未超龄 ⇒ 拒绝接管）', () => {
  withWorkspace((root) => {
    const lock = new WorkflowRunLock(root);
    lock.acquire('run_remote_1');
    const path = lock.pathOf('run_remote_1');
    // 另一个主机上的锁：PID 是那个主机的（这里填一个本机不存在的值也不能据此判死）。
    writeFileSync(
      path,
      `${JSON.stringify({ pid: deadPid(), host: 'other-host', at: new Date().toISOString(), runId: 'run_remote_1' })}\n`,
      'utf8',
    );
    assert.throws(() => lock.acquire('run_remote_1'), /正被另一进程续跑/);
    lock.release('run_remote_1');
  });
});

test('WorkflowRunLock：release 只删自己的锁（不越权删已接管者的锁）', () => {
  withWorkspace((root) => {
    const lock = new WorkflowRunLock(root);
    lock.acquire('run_owner_1');
    const path = lock.pathOf('run_owner_1');
    // 模拟「锁已被另一个进程接管」：把 pid 改成别人的。
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid + 1, host: 'x', at: new Date().toISOString(), runId: 'run_owner_1' })}\n`,
      'utf8',
    );
    lock.release('run_owner_1');
    assert.strictEqual(existsSync(path), true, '不是自己的锁不得删除');
    rmSync(path, { force: true });
  });
});

test('WorkflowRunLock：真子进程持锁期间父进程必须被拒；子进程消失后自动接管', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-lock-x-'));
  const script = join(root, 'hold-lock.mjs');
  writeFileSync(
    script,
    [
      `import { WorkflowRunLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
      'const lock = new WorkflowRunLock(process.argv[2]);',
      'lock.acquire(process.argv[3]);',
      "process.stdout.write('locked\\n');",
      'setTimeout(() => {}, 4000);',
    ].join('\n'),
    'utf8',
  );
  const child = spawn(process.execPath, [script, root, 'run_cross_1'], {
    // stdin 一律 ignore（本机 Windows 上给子进程建 stdin 管道是已知 EBUSY 陷阱）。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const locked = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程未在 20s 内持锁')), 20_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('locked')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on('error', reject);
    });
    assert.strictEqual(locked, true);

    // 子进程活着 ⇒ 父进程必须被拒（这是本锁存在的全部理由）。
    assert.throws(() => new WorkflowRunLock(root).acquire('run_cross_1'), /正被另一进程续跑/);

    // 等子进程退出（它**不释放锁**，模拟被 kill）⇒ 死 PID 必须能被接管。
    await new Promise((resolve) => child.on('exit', resolve));
    const taken = new WorkflowRunLock(root).acquire('run_cross_1');
    assert.strictEqual(taken.pid, process.pid, '持锁进程消失后必须自动接管');
    new WorkflowRunLock(root).release('run_cross_1');
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('WorkflowRunLock：锁文件是自描述的（pid/host/at/runId 齐全，便于人排查）', () => {
  withWorkspace((root) => {
    const lock = new WorkflowRunLock(root);
    lock.acquire('run_desc_1');
    const parsed = JSON.parse(readFileSync(lock.pathOf('run_desc_1'), 'utf8'));
    assert.strictEqual(parsed.runId, 'run_desc_1');
    assert.strictEqual(parsed.pid, process.pid);
    assert.ok(typeof parsed.host === 'string' && parsed.host.length > 0);
    assert.match(String(parsed.at), /^\d{4}-\d{2}-\d{2}T/);
    lock.release('run_desc_1');
  });
});

test('WorkflowRunLock：runId 非法（路径穿越）即拒绝', () => {
  withWorkspace((root) => {
    const lock = new WorkflowRunLock(root);
    assert.throws(() => lock.pathOf('../escape'), WorkflowSpecError);
    assert.throws(() => lock.acquire('a/b'), WorkflowSpecError);
  });
});
