/**
 * 临时目录清扫判据：只删本仓前缀 + 超龄条目；不碰新条目、非本仓条目、符号链接。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TmpSweep } from '../../src/util/tmpSweep.ts';

/** 造一个条目并把 mtime 设为指定时间。 */
function make(root: string, name: string, ageMs: number, directory: boolean): string {
  const path = join(root, name);
  if (directory) {
    mkdirSync(path, { recursive: true });
  } else {
    writeFileSync(path, 'x', 'utf8');
  }
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

test('TmpSweep：只清本仓前缀且超龄的条目，保留新条目/外来条目', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-sweep-test-'));
  try {
    const oldDir = make(root, 'omni-chrome-old', 48 * 60 * 60 * 1000, true);
    const oldFile = make(root, 'laya-req-old.json', 48 * 60 * 60 * 1000, false);
    const fresh = make(root, 'omni-chrome-fresh', 60 * 1000, true);
    const foreign = make(root, 'other-tool-old', 48 * 60 * 60 * 1000, true);
    const report = TmpSweep.run({ tmpDir: root });
    assert.deepStrictEqual([...report.matched].sort(), [oldDir, oldFile].sort());
    assert.strictEqual(report.removed, 2);
    assert.ok(!report.matched.includes(fresh));
    assert.ok(!report.matched.includes(foreign));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TmpSweep：dry-run 不删除；符号链接跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-sweep-dry-'));
  try {
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'omni-chrome-link');
    let linked = true;
    try {
      symlinkSync(target, link);
    } catch {
      // Windows 未开开发者模式时普通用户不能建符号链接；该平台跳过这一条断言。
      linked = false;
    }
    const old = make(root, 'omni-wt-old', 48 * 60 * 60 * 1000, true);
    const report = TmpSweep.run({ tmpDir: root, dryRun: true });
    assert.ok(report.matched.includes(old));
    if (linked) {
      assert.ok(report.skipped.some((path) => path.includes('omni-chrome-link')));
    }
    assert.strictEqual(report.removed, 0);
    const after = TmpSweep.run({ tmpDir: root, dryRun: true });
    assert.ok(after.matched.includes(old), 'dry-run 后条目仍在');
    const applied = TmpSweep.run({ tmpDir: root });
    assert.strictEqual(applied.removed, 1, '实际删除数不能把跳过的符号链接算进去');
    assert.ok(!report.matched.includes(link));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
