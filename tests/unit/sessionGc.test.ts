/**
 * 会话保留策略（SessionGc）判据：keepNewest 保护 / 年龄淘汰 / 总量封顶 / 归档优先 /
 * dry-run 不动手 / sidecar 随主文件整组删 / 孤儿附件按引用集删（被引用的不动）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionGc } from '../../src/util/sessionGc.ts';

const DAY = 24 * 60 * 60 * 1000;

/** 建一个会话组（主文件 + sidecar）并把 mtime 拨到指定年龄。 */
function makeSession(dir: string, id: string, ageMs: number, content = 'x'): void {
  const base = join(dir, `sess_${id}.jsonl`);
  writeFileSync(base, content, 'utf8');
  writeFileSync(`${base}.summary.json`, '{}', 'utf8');
  const when = new Date(Date.now() - ageMs);
  utimesSync(base, when, when);
  utimesSync(`${base}.summary.json`, when, when);
}

test('SessionGc：超龄组整组删除（含 sidecar）；keepNewest 内的超龄组绝不删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gc-test-'));
  try {
    makeSession(dir, 'old1', 100 * DAY);
    makeSession(dir, 'old2', 100 * DAY);
    makeSession(dir, 'fresh', 1 * DAY);
    // keepNewest=1 只保护最新的 fresh；两个超龄组整组走人（含 sidecar）。
    const report = SessionGc.run({
      sessionsDir: dir,
      keepNewest: 1,
      maxAgeMs: 90 * DAY,
      now: Date.now(),
    });
    assert.ok(!existsSync(join(dir, 'sess_old1.jsonl')));
    assert.ok(!existsSync(join(dir, 'sess_old1.jsonl.summary.json')), 'sidecar 必须随主文件一起删');
    assert.ok(!existsSync(join(dir, 'sess_old2.jsonl')));
    assert.ok(existsSync(join(dir, 'sess_fresh.jsonl')), '年轻组不动');
    assert.strictEqual(report.deletedGroups.length, 4); // 2 组 × 2 文件
    assert.ok(report.freedBytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionGc：keepNewest 按新排序保护——最老的组被优先淘汰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gc-test-'));
  try {
    makeSession(dir, 'young', 1 * DAY);
    makeSession(dir, 'mid', 100 * DAY);
    makeSession(dir, 'old', 200 * DAY);
    // mid/old 均超龄；keepNewest=1 保护"最新"的 young。
    SessionGc.run({ sessionsDir: dir, keepNewest: 1, maxAgeMs: 90 * DAY, now: Date.now() });
    assert.ok(existsSync(join(dir, 'sess_young.jsonl')), '最新的组受保护');
    assert.ok(!existsSync(join(dir, 'sess_mid.jsonl')));
    assert.ok(!existsSync(join(dir, 'sess_old.jsonl')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionGc：总量封顶——超上限时从最老开始删到回落（即使未超龄）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gc-test-'));
  try {
    makeSession(dir, 'a', 1 * DAY, 'A'.repeat(600));
    makeSession(dir, 'b', 2 * DAY, 'B'.repeat(600));
    makeSession(dir, 'c', 3 * DAY, 'C'.repeat(600));
    // 上限 1KB ⇒ 必须删到 1KB 以下：最老的 c、b 走人，keepNewest=1 保护 a。
    SessionGc.run({
      sessionsDir: dir,
      keepNewest: 1,
      maxAgeMs: 90 * DAY,
      maxBytes: 1024,
      now: Date.now(),
    });
    assert.ok(existsSync(join(dir, 'sess_a.jsonl')), '最新组受保护');
    assert.ok(!existsSync(join(dir, 'sess_b.jsonl')));
    assert.ok(!existsSync(join(dir, 'sess_c.jsonl')), '最老组先删');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionGc：归档目录优先删除；dry-run 全程不动手', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gc-test-'));
  try {
    mkdirSync(join(dir, 'archive'));
    makeSession(dir, 'hot', 80 * DAY);
    makeSession(dir, 'stale-main', 100 * DAY);
    makeSession(join(dir, 'archive'), 'cold', 100 * DAY);
    const dry = SessionGc.run({
      sessionsDir: dir,
      keepNewest: 0,
      maxAgeMs: 90 * DAY,
      dryRun: true,
      now: Date.now(),
    });
    assert.ok(dry.dryRun);
    assert.ok(existsSync(join(dir, 'sess_hot.jsonl')), 'dry-run 不动手');
    assert.ok(existsSync(join(dir, 'archive', 'sess_cold.jsonl')), 'dry-run 不动手');
    // 超龄的两个组（主目录 stale-main + 归档 cold）都在清单，hot（80 天）不在。
    assert.strictEqual(dry.deletedGroups.length, 4);
    assert.ok(
      dry.deletedGroups.every((file) => !file.includes('sess_hot')),
      '年轻组不进删除清单',
    );
    // 归档优先：删除清单里归档组的文件排在主目录组之前。
    const firstCold = dry.deletedGroups.findIndex((file) => file.includes('archive'));
    const firstMain = dry.deletedGroups.findIndex((file) => !file.includes('archive'));
    assert.ok(
      firstCold !== -1 && firstMain !== -1 && firstCold < firstMain,
      '归档组先于主目录组进入删除清单',
    );

    // 实删：hot 比 90 天阈值年轻（且 keepNewest=1），两组超龄的走人。
    SessionGc.run({ sessionsDir: dir, keepNewest: 1, maxAgeMs: 90 * DAY, now: Date.now() });
    assert.ok(existsSync(join(dir, 'sess_hot.jsonl')), '年轻的热组受保护');
    assert.ok(!existsSync(join(dir, 'archive', 'sess_cold.jsonl')), '超龄的归档组被淘汰');
    assert.ok(!existsSync(join(dir, 'sess_stale-main.jsonl')), '超龄的主目录组被淘汰');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionGc：孤儿附件按引用集删——被存活会话引用的不动，未引用且超龄的删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gc-test-'));
  try {
    mkdirSync(join(dir, 'attachments'));
    const referenced = 'a'.repeat(64) + '.png';
    const orphan = 'b'.repeat(64) + '.png';
    const freshOrphan = 'c'.repeat(64) + '.png';
    writeFileSync(join(dir, 'attachments', referenced), 'R');
    writeFileSync(join(dir, 'attachments', orphan), 'O');
    writeFileSync(join(dir, 'attachments', freshOrphan), 'F');
    // 存活会话引用了 referenced；会话本身年轻（受保护，留着）。
    makeSession(dir, 'live', 1 * DAY, JSON.stringify({ path: referenced }));
    const old = new Date(Date.now() - 100 * DAY);
    utimesSync(join(dir, 'attachments', referenced), old, old);
    utimesSync(join(dir, 'attachments', orphan), old, old);
    // freshOrphan 未被引用但很新：年龄阈值兜住"刚写附件还没落引用"的竞态，不删。
    SessionGc.run({ sessionsDir: dir, keepNewest: 5, maxAgeMs: 90 * DAY, now: Date.now() });
    assert.ok(existsSync(join(dir, 'attachments', referenced)), '被引用的附件绝不删（哪怕超龄）');
    assert.ok(!existsSync(join(dir, 'attachments', orphan)), '未引用且超龄的孤儿附件删');
    assert.ok(existsSync(join(dir, 'attachments', freshOrphan)), '未引用但年轻的附件留给下轮');
    assert.ok(existsSync(join(dir, 'sess_live.jsonl')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionGc：附件引用判定读的是删除后仍存活的会话（被删会话的引用不救附件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gc-test-'));
  try {
    mkdirSync(join(dir, 'attachments'));
    const onlyFromDead = 'd'.repeat(64) + '.png';
    writeFileSync(join(dir, 'attachments', onlyFromDead), 'X');
    // 唯一引用者本身超龄被删 ⇒ 附件成为孤儿（超龄）⇒ 删。
    makeSession(dir, 'dead', 100 * DAY, JSON.stringify({ path: onlyFromDead }));
    const old = new Date(Date.now() - 100 * DAY);
    utimesSync(join(dir, 'attachments', onlyFromDead), old, old);
    const report = SessionGc.run({
      sessionsDir: dir,
      keepNewest: 0,
      maxAgeMs: 90 * DAY,
      now: Date.now(),
    });
    assert.ok(!existsSync(join(dir, 'attachments', onlyFromDead)));
    assert.strictEqual(report.deletedAttachments.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionGc：报告反映实际删除内容（文件级清单）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gc-test-'));
  try {
    makeSession(dir, 'gone', 100 * DAY);
    const report = SessionGc.run({
      sessionsDir: dir,
      keepNewest: 0,
      maxAgeMs: 90 * DAY,
      now: Date.now(),
    });
    assert.strictEqual(report.groupsScanned, 1);
    assert.ok(report.deletedGroups.some((file) => file.endsWith('sess_gone.jsonl')));
    assert.ok(
      report.deletedGroups.every((file) => existsSync(file) === false),
      '清单里的文件应确已删除',
    );
    assert.ok(report.skipped.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
