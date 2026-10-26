/**
 * ServeInstance.sweepAll 判据：全量清扫死进程记录、脏记录清文件、活记录与非 serve-*.pid 文件不碰。
 * 背景：`sweep`（单端口）只在"新 serve 起同一端口"时被调，临时高位端口几乎不会被重启——
 * 本机实测积压 19 份陈旧记录；维护巡检按目录整体扫一遍才自愈。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServeInstance } from '../../src/cli/serveInstance.ts';

/** announce 所需的记录形状。 */
interface PidRecord {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  readonly startedAt: string;
  readonly workspace: string;
  readonly version: string;
}

function recordOf(pid: number, port: number): PidRecord {
  return {
    pid,
    port,
    host: '127.0.0.1',
    startedAt: new Date().toISOString(),
    workspace: 'D:\\ws',
    version: '0',
  };
}

test('sweepAll：死记录删、活记录留、脏记录清文件、非 serve-*.pid 不碰', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-sweepall-test-'));
  try {
    const dir = join(home, '.omniharness');
    const deadPath = ServeInstance.announce(recordOf(4194303, 58001), join(dir, 'serve-58001.pid'));
    const livePath = ServeInstance.announce(
      recordOf(process.pid, 58002),
      join(dir, 'serve-58002.pid'),
    );
    const dirtyPath = join(dir, 'serve-58003.pid');
    writeFileSync(dirtyPath, '{not-json', 'utf8');
    const otherPath = join(dir, 'daemon.pid');
    writeFileSync(otherPath, '{"pid":1}', 'utf8');

    const swept = ServeInstance.sweepAll(home, (pid) => pid === process.pid);
    assert.strictEqual(swept.length, 1);
    assert.strictEqual(swept[0]?.port, 58001);
    assert.ok(!existsSync(deadPath), '死记录被清');
    assert.ok(existsSync(livePath), '活记录不碰');
    assert.ok(!existsSync(dirtyPath), '脏记录文件被清（已无意义）');
    assert.ok(existsSync(otherPath), '非 serve-*.pid 不碰');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('sweepAll：目录不存在返回空账（不抛）', () => {
  const swept = ServeInstance.sweepAll(join(tmpdir(), 'omni-sweepall-missing-xyz'));
  assert.deepStrictEqual(swept, []);
});
