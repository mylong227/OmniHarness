import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonController } from '../../src/daemon/daemon.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpPidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oh-daemon-'));
  return join(dir, 'daemon.pid');
}

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
