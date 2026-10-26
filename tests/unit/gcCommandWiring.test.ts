/**
 * gc 子命令接线判据：execLocal 分发到达 / 用法守卫 / dry-run 透传 / 输出明细 /
 * `--dry-run` 已登记进 knownFlags（fail-closed 口径下未登记的旗标会被判据点名）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { GcCommand } from '../../src/cli/gcCommand.ts';
import { ExecLocal } from '../../src/cli/execLocal.ts';
import { KNOWN_EXTRA_FLAGS } from '../../src/cli/knownFlags.ts';
import type { MaintenanceOptions, MaintenanceReport } from '../../src/util/maintenanceRunner.ts';

/** 恒返回固定空账报告的假执行体（不碰真机目录）。 */
function fakeRunner(captured: {
  options?: MaintenanceOptions;
}): (options: MaintenanceOptions) => MaintenanceReport {
  return (options) => {
    captured.options = options;
    return {
      enabled: true,
      dryRun: options.dryRun === true,
      tmp: [
        {
          scanned: 3,
          matched: ['C:\\Temp\\omni-cdp-old'],
          removed: 1,
          skipped: [],
          dryRun: false,
          errors: [],
        },
      ],
      pidSwept: [
        {
          pid: 42,
          port: 8787,
          host: '127.0.0.1',
          startedAt: '2026-10-01T00:00:00Z',
          workspace: 'D:\\ws',
          version: '0',
        },
      ],
      sessions: {
        groupsScanned: 10,
        totalBytes: 1024,
        deletedGroups: ['D:\\h\\sessions\\sess_gone.jsonl'],
        deletedAttachments: [],
        freedBytes: 1024,
        skipped: [],
        dryRun: false,
      },
      sessionTempFiles: 0,
    };
  };
}

test('gc：未知位置参数 ⇒ 用法 + 退出码 2', () => {
  const code = new GcCommand().run(['bogus'], fakeRunner({}));
  assert.strictEqual(code, 2);
});

test('gc：--dry-run 透传给巡检执行体，输出摘要与明细', () => {
  const captured: { options?: MaintenanceOptions } = {};
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = new GcCommand().run(['--dry-run'], fakeRunner(captured));
    assert.strictEqual(code, 0);
    assert.strictEqual(captured.options?.dryRun, true);
  } finally {
    process.stdout.write = original;
  }
  const out = writes.join('');
  assert.ok(out.includes('维护巡检'), `摘要行应出现（实测：${out}）`);
  assert.ok(out.includes('serve-8787.pid'), '陈旧实例记录明细应出现');
  assert.ok(out.includes('sess_gone.jsonl'), '会话组明细应出现');
});

test('gc：execLocal 分发到达（命令名注册）', async () => {
  const exec = new ExecLocal();
  // 用一个必然不存在的注入面探测：runGc 是 protected，经由 runLocal 分发；
  // 但 runLocal 会真的执行巡检——这里只验证「分发不落到 agent 路径」：给非法参数（退出码 2 而非 undefined）。
  const code = await exec.runLocal(['gc', 'bogus']);
  assert.strictEqual(code, 2, 'gc 被分发（返回退出码），而非 undefined（落 agent）');
});

test('knownFlags：--dry-run 已登记（gc 命令的 includes 式读取必须在册）', () => {
  assert.ok(KNOWN_EXTRA_FLAGS.has('--dry-run'));
});
