import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DaemonController } from '../../src/daemon/daemonController.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpPidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oh-daemon-'));
  return join(dir, 'daemon.pid');
}

test('DaemonController：默认后台入口是 CLI exec，不是 daemonController 自身', () => {
  assert.match(
    DaemonController.defaultEntry(),
    /[\\/]cli[\\/]exec\.js$/u,
    '入口必须是 dist/src/cli/exec.js（历史缺陷：指向 daemonController 自身 ⇒ 永远起不了 serve）',
  );
  assert.doesNotMatch(DaemonController.defaultEntry(), /daemonController/u);
});

test('DaemonController：入口不存在时 start 必须失败，不得写 PID 报“已启动”', () => {
  const pidFile = tmpPidFile();
  const controller = new DaemonController({
    pidFile,
    entry: join(tmpdir(), 'omni-daemon-no-such-entry.js'),
    // 就绪窗口放大到 5s：判据要验的是"子进程退出即抛错"，不是"800ms 内必被调度到"。
    // 满载并行时默认 800ms 会让这条偶发红（2026-10-18 实测），那是调度延迟不是产品缺陷。
    probeMs: 5000,
  });
  assert.throws(() => controller.start([], 18787), /立即退出/u);
  assert.strictEqual(existsSync(pidFile), false, '启动失败不得留下 PID 文件');
  rmSync(pidFile, { recursive: true, force: true });
});

test(
  'DaemonController：start 写 PID+启动时刻，stop 校验身份后杀掉真实进程',
  { timeout: 90_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-daemon-start-'));
    const entry = join(dir, 'sleeper.mjs');
    // 入口是真实 node 脚本：忽略 serve 参数、稳定存活到 stop。
    writeFileSync(entry, 'setTimeout(() => undefined, 60_000);\n', 'utf8');
    const pidFile = join(dir, 'daemon.pid');
    const controller = new DaemonController({ pidFile, entry });
    try {
      const pid = controller.start([], 18788);
      const record = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        pid: number;
        startedAt?: number;
      };
      assert.strictEqual(record.pid, pid);
      assert.strictEqual(typeof record.startedAt, 'number', '新 PID 文件必须带启动时刻');
      assert.strictEqual(controller.status().running, true);
      assert.strictEqual(controller.stop(), true);
      assert.strictEqual(existsSync(pidFile), false);
    } finally {
      controller.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);

test('DaemonController：陈旧 PID 被复用时 stop 不得杀无关进程', { timeout: 90_000 }, async () => {
  const pidFile = tmpPidFile();
  const controller = new DaemonController({ pidFile });
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid;
  assert.ok(pid !== undefined, '哑进程应有 pid');
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 故意写一个不可能匹配的启动时刻（模拟 PID 被复用）。
    writeFileSync(pidFile, JSON.stringify({ pid, startedAt: 1 }));
    assert.strictEqual(controller.stop(), false, '身份不匹配必须拒绝 kill');
    assert.strictEqual(existsSync(pidFile), false, '可确认的陈旧记录应被清理');
    // 哑进程必须仍活着。
    assert.doesNotThrow(() => process.kill(pid, 0), '无关进程不得被误杀');
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    rmSync(pidFile, { recursive: true, force: true });
  }
});

test('DaemonController：status 探测存活与 PID 文件清理', async () => {
  const pidFile = tmpPidFile();
  const controller = new DaemonController({ pidFile });

  // 无文件 → 未运行
  assert.strictEqual(controller.status().running, false);

  // 写入一个不存在的 PID → kill(0) 失败 → 视为未运行
  writeFileSync(pidFile, '999999');
  assert.strictEqual(controller.status().running, false);
  rmSync(pidFile, { force: true });

  // 启动一个真实后台哑进程，写其 PID，status 应报告 running；stop 后文件被删
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  assert.strictEqual(controller.status().running, true);
  assert.strictEqual(controller.stop(), true);
  assert.strictEqual(existsSync(pidFile), false);

  rmSync(pidFile, { recursive: true, force: true });
});

test('DaemonController：stop 无 PID 文件时静默返回 false', () => {
  const pidFile = tmpPidFile();
  const controller = new DaemonController({ pidFile });
  assert.strictEqual(controller.stop(), false);
  rmSync(pidFile, { recursive: true, force: true });
});
