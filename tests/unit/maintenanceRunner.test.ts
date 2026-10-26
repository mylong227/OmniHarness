/**
 * 维护巡检编排器（MaintenanceRunner）判据：旋钮停用 / 三类清扫各归其账 / 汇总行可读。
 * 全部用注入（env/home/tmpRoots/aliveFn/now），不碰真机的 ~/.omniharness 与 OS Temp。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaintenanceRunner } from '../../src/util/maintenanceRunner.ts';
import { ServeInstance } from '../../src/cli/serveInstance.ts';

const DAY = 24 * 60 * 60 * 1000;

test('MaintenanceRunner：OMNI_MAINTENANCE=off 一键停用（空账 + 原因）', () => {
  const report = MaintenanceRunner.run({
    env: { OMNI_MAINTENANCE: 'off' },
    tmpRoots: [],
    home: 'D:\\nonexistent-oh-home',
  });
  assert.strictEqual(report.enabled, false);
  assert.strictEqual(report.tmp.length, 0);
  assert.strictEqual(report.sessions, null);
  assert.ok(MaintenanceRunner.summarize(report).includes('已停用'));
});

test('MaintenanceRunner：临时清扫（超龄 omni-* 删、新条目留）+ 陈旧 pid 记录清扫 + 会话 GC 一轮完成', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-mnt-home-'));
  const tmpRoot = mkdtempSync(join(tmpdir(), 'omni-mnt-tmp-'));
  try {
    // ① 临时根里的超龄孤儿（本仓前缀）与新条目。
    const staleDir = join(tmpRoot, 'omni-cdp-stale');
    mkdirSync(staleDir);
    writeFileSync(join(staleDir, 'x'), 'x');
    const staleAge = new Date(Date.now() - 2 * DAY);
    utimesSync(staleDir, staleAge, staleAge);
    const freshDir = join(tmpRoot, 'omni-cdp-fresh');
    mkdirSync(freshDir);
    // ② 会话：一组超龄（删）+ 一组年轻（留）。注入 home ⇒ 会话目录 = <home>/.omniharness/sessions。
    const sessionsDir = join(home, '.omniharness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const ancient = new Date(Date.now() - 100 * DAY);
    const oldBase = join(sessionsDir, 'sess_old.jsonl');
    writeFileSync(oldBase, 'o', 'utf8');
    writeFileSync(`${oldBase}.summary.json`, '{}', 'utf8');
    utimesSync(oldBase, ancient, ancient);
    utimesSync(`${oldBase}.summary.json`, ancient, ancient);
    writeFileSync(join(sessionsDir, 'sess_new.jsonl'), 'n', 'utf8');
    // ③ 陈旧实例记录：死 pid（判活注入恒 false）+ 本进程（活）。记录目录 = <home>/.omniharness。
    const ohDir = join(home, '.omniharness');
    const dead = {
      pid: 4194304,
      port: 59999,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      workspace: home,
      version: '0',
    };
    const deadPath = ServeInstance.announce(dead, join(ohDir, 'serve-59999.pid'));
    const alive = { ...dead, pid: process.pid, port: 59998 };
    ServeInstance.announce(alive, join(ohDir, 'serve-59998.pid'));

    const report = MaintenanceRunner.run({
      home,
      tmpRoots: [tmpRoot],
      env: {},
      aliveFn: (pid) => pid === process.pid,
      olderThanMs: DAY,
      keepNewest: 1,
      sessionMaxAgeMs: 90 * DAY,
    });
    assert.strictEqual(report.enabled, true);
    assert.strictEqual(report.tmp.length, 1);
    assert.ok((report.tmp[0]?.removed ?? 0) >= 1, '超龄孤儿被清');
    assert.ok(existsSync(freshDir), '新条目不碰');
    assert.ok(!existsSync(deadPath), '死进程记录被清');
    assert.ok(existsSync(join(ohDir, 'serve-59998.pid')), '活进程记录不碰');
    assert.strictEqual(report.pidSwept.length, 1);
    assert.strictEqual(report.pidSwept[0]?.port, 59999);
    assert.ok(report.sessions !== null, '会话 GC 跑了');
    assert.ok(report.sessions.deletedGroups.some((file) => file.endsWith('sess_old.jsonl')));
    assert.ok(!existsSync(oldBase));
    assert.ok(existsSync(join(sessionsDir, 'sess_new.jsonl')), '年轻会话不动');
    // 真进程判活（默认实现）下，本进程的记录绝不被清扫——"GC 不误伤"的主保险。
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('MaintenanceRunner：OMNI_GC_* 环境旋钮覆盖保留策略（非法值回落缺省）', () => {
  const env = { OMNI_GC_KEEP: '0', OMNI_GC_MAX_AGE_DAYS: '1', OMNI_GC_MAX_BYTES: '1024' };
  const params = MaintenanceRunner.gcParamsFromEnv(env, {
    keepNewest: 50,
    maxAgeMs: 90 * DAY,
    maxBytes: 4 * 1024 * 1024 * 1024,
  });
  assert.deepStrictEqual(params, { keepNewest: 0, maxAgeMs: DAY, maxBytes: 1024 });
  const bad = MaintenanceRunner.gcParamsFromEnv(
    { OMNI_GC_KEEP: 'x', OMNI_GC_MAX_AGE_DAYS: '-3', OMNI_GC_MAX_BYTES: 'NaN' },
    { keepNewest: 50, maxAgeMs: 90 * DAY, maxBytes: 8 },
  );
  assert.deepStrictEqual(
    bad,
    { keepNewest: 50, maxAgeMs: 90 * DAY, maxBytes: 8 },
    '非法旋钮回落缺省，不能让维护停摆',
  );
});

test('MaintenanceRunner：dry-run 透传到会话 GC（不动手）', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-mnt-dry-'));
  try {
    const sessionsDir = join(home, '.omniharness', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const base = join(sessionsDir, 'sess_old.jsonl');
    writeFileSync(base, 'o', 'utf8');
    const old = new Date(Date.now() - 100 * DAY);
    utimesSync(base, old, old);
    const report = MaintenanceRunner.run({
      home,
      tmpRoots: [],
      env: {},
      dryRun: true,
      keepNewest: 0,
      sessionMaxAgeMs: 90 * DAY,
    });
    assert.ok(report.sessions !== null && report.sessions.deletedGroups.length >= 1);
    assert.ok(existsSync(base), 'dry-run 不得删除');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('MaintenanceRunner：summarize 汇总行把文件级清单并成会话组数', () => {
  const fake: Parameters<typeof MaintenanceRunner.summarize>[0] = {
    enabled: true,
    dryRun: false,
    tmp: [],
    pidSwept: [],
    sessionTempFiles: 0,
    sessions: {
      groupsScanned: 2,
      totalBytes: 2048,
      deletedGroups: [
        'D:\\h\\sessions\\archive\\sess_a.jsonl',
        'D:\\h\\sessions\\archive\\sess_a.jsonl.summary.json',
      ],
      deletedAttachments: ['D:\\h\\sessions\\attachments\\x.png'],
      freedBytes: 2048,
      skipped: [],
      dryRun: false,
    },
  };
  const line = MaintenanceRunner.summarize(fake);
  assert.ok(line.includes('会话组 1'), `sidecar 不得并成第二个组（实测：${line}）`);
  assert.ok(line.includes('孤儿附件 1'));
  assert.ok(line.includes('2.0 KB'));
});
