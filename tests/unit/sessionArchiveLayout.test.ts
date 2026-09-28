// 归档**冷存储**门禁（真文件、真 IO）：用户要求「归档冷存储也做完」。
//
// ## 语义
//
// 归档 = 把 `.jsonl` 挪进 `archive/` 子目录（`rename`，同分区原子），恢复 = 挪回主目录。不变量：
// ① 任何时刻文件只在其中一处（不存在「两边都有半截」或「两边都没有」的中间态）；
// ② 归档会话**仍可读**（历史不可丢）：事件存储与遥测读取都要回落归档目录；
// ③ 归档会话**续聊前先挪回主目录**（`ensureMain`），否则主目录会新建一个只有新事件的文件，把历史劈成两半。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionArchiveLayout } from '../../src/util/sessionArchiveLayout.js';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.js';
import { SessionArchive } from '../../src/server/services/sessionArchive.js';

/** 在临时目录内执行。 */
function withTemp<T>(fn: (dir: string) => T | Promise<T>): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), 'session-coldstorage-'));
  const done = (): void => rmSync(dir, { recursive: true, force: true });
  const r = fn(dir);
  if (r instanceof Promise) return r.finally(done);
  done();
  return r;
}

/** 一行事件。 */
function line(type: string, payload: unknown): string {
  return JSON.stringify({
    id: 'e',
    type,
    sessionId: 's',
    timestamp: '2026-09-11T00:00:00.000Z',
    payload,
  });
}

test('布局：归档 → 主目录不再有文件、归档目录有；恢复 → 挪回', () => {
  withTemp((dir) => {
    writeFileSync(SessionArchiveLayout.mainFileOf(dir, 'a'), line('user', { content: '甲' }));
    assert.strictEqual(SessionArchiveLayout.archive(dir, 'a'), 'moved');
    assert.strictEqual(existsSync(SessionArchiveLayout.mainFileOf(dir, 'a')), false);
    assert.strictEqual(existsSync(SessionArchiveLayout.archivedFileOf(dir, 'a')), true);
    assert.strictEqual(SessionArchiveLayout.isArchived(dir, 'a'), true);
    assert.strictEqual(
      SessionArchiveLayout.find(dir, 'a'),
      SessionArchiveLayout.archivedFileOf(dir, 'a'),
    );
    assert.strictEqual(SessionArchiveLayout.archive(dir, 'a'), 'noop', '重复归档必须幂等');
    assert.strictEqual(SessionArchiveLayout.restore(dir, 'a'), 'moved');
    assert.strictEqual(existsSync(SessionArchiveLayout.mainFileOf(dir, 'a')), true);
    assert.strictEqual(SessionArchiveLayout.restore(dir, 'a'), 'noop', '重复恢复必须幂等');
    assert.strictEqual(SessionArchiveLayout.restore(dir, 'ghost'), 'missing');
  });
});

test('归档会话仍可读：JsonlStorage.load 回落归档目录（历史不可丢）', async () => {
  await withTemp(async (dir) => {
    const storage = new JsonlStorage(dir);
    await storage.save('a', [
      {
        id: 'e1',
        sessionId: 'a',
        timestamp: '2026-09-11T00:00:00.000Z',
        type: 'user' as const,
        payload: { content: '甲' },
      },
    ]);
    assert.strictEqual((await storage.load('a')).length, 1);
    SessionArchiveLayout.archive(dir, 'a');
    const after = await storage.load('a');
    assert.strictEqual(
      after.length,
      1,
      '归档后仍必须读到历史（否则「打开归档会话」看起来像历史丢了）',
    );
  });
});

test('续聊归档会话：save 前先把文件挪回主目录（不劈历史）', async () => {
  await withTemp(async (dir) => {
    const storage = new JsonlStorage(dir);
    const first = {
      id: 'e1',
      sessionId: 'a',
      timestamp: '2026-09-11T00:00:00.000Z',
      type: 'user' as const,
      payload: { content: '甲' },
    };
    await storage.save('a', [first]);
    SessionArchiveLayout.archive(dir, 'a');
    const second = {
      id: 'e2',
      sessionId: 'a',
      timestamp: '2026-09-11T00:01:00.000Z',
      type: 'user' as const,
      payload: { content: '乙' },
    };
    await storage.save('a', [first, second]);
    assert.strictEqual(
      existsSync(SessionArchiveLayout.archivedFileOf(dir, 'a')),
      false,
      '写入时必须已挪回',
    );
    assert.strictEqual((await storage.load('a')).length, 2);
  });
});

test('跨分区回退：rename 抛 EXDEV 时改走「复制 → 校验 → 目标内原子改名 → 删源」', () => {
  withTemp((dir) => {
    const src = SessionArchiveLayout.mainFileOf(dir, 'a');
    const dest = SessionArchiveLayout.archivedFileOf(dir, 'a');
    writeFileSync(src, line('user', { content: '甲' }));
    const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    const moves: string[] = [];
    const r = SessionArchiveLayout.moveFile(src, dest, (from, to) => {
      moves.push(`${from} → ${to}`);
      if (moves.length === 1) throw exdev; // 第一次 rename 失败（模拟跨设备）⇒ 必须走复制回退
      renameSync(from, to);
    });
    assert.strictEqual(r, 'moved');
    assert.strictEqual(
      moves.length >= 2,
      true,
      `回退路径必须再做一次「目标目录内」的 rename（实测 ${moves.length} 次）`,
    );
    assert.strictEqual(existsSync(src), false, '源必须被删掉（复制已校验通过）');
    assert.strictEqual(existsSync(dest), true, '目标必须就位');
    assert.strictEqual(
      readFileSync(dest, 'utf8'),
      line('user', { content: '甲' }),
      '内容必须逐字节一致',
    );
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, [], '不得残留临时文件');
  });
});

test('跨分区回退：校验失败 ⇒ 抛错且不留下目标文件（源消失时宁可失败）', () => {
  withTemp((dir) => {
    const src = SessionArchiveLayout.mainFileOf(dir, 'a');
    const dest = SessionArchiveLayout.archivedFileOf(dir, 'a');
    writeFileSync(src, line('user', { content: '甲' }));
    const exdev = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    assert.throws(() => {
      SessionArchiveLayout.moveFile(src, dest, () => {
        rmSync(src, { force: true }); // 模拟「跨分区复制过程中源被外部删掉」⇒ 复制校验必然失败
        throw exdev;
      });
    });
    assert.strictEqual(existsSync(dest), false, '校验失败时不得留下目标文件');
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.includes('.tmp')),
      [],
      '不得残留临时文件',
    );
  });
});

test('被打断的跨分区搬运：下次归档按大小清理重复（半截的那份被丢弃）', () => {
  withTemp((dir) => {
    const src = SessionArchiveLayout.mainFileOf(dir, 'a');
    const dest = SessionArchiveLayout.archivedFileOf(dir, 'a');
    writeFileSync(src, line('user', { content: '完整内容' }));
    mkdirSync(SessionArchiveLayout.archiveDirOf(dir), { recursive: true });
    writeFileSync(dest, '半截'); // 上次复制被打断留下的半截副本
    assert.strictEqual(SessionArchiveLayout.archive(dir, 'a'), 'moved');
    assert.strictEqual(existsSync(src), false);
    assert.strictEqual(existsSync(dest), true);
    assert.strictEqual(
      readFileSync(dest, 'utf8'),
      line('user', { content: '完整内容' }),
      '必须保留完整的那份',
    );
  });
});

test('遗留临时文件清理：只清「过期」的（正在搬运的刚创建，不得误删）', () => {
  withTemp((dir) => {
    const oldTmp = join(dir, 'a.jsonl.123.tmp');
    const freshTmp = join(dir, 'b.jsonl.456.tmp');
    writeFileSync(oldTmp, '旧');
    writeFileSync(freshTmp, '新');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
    const removed = SessionArchiveLayout.sweepTempFiles(dir, 3_600_000);
    assert.strictEqual(removed, 1, '只应清掉过期的那一个');
    assert.strictEqual(existsSync(oldTmp), false);
    assert.strictEqual(existsSync(freshTmp), true, '刚创建的临时文件不得被误删');
  });
});

test('接线：列表首读会做一次遗留临时文件清扫（生产里真的会跑，不只是「有这个函数」）', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    const stale = join(dir, 'a.jsonl.999.tmp');
    writeFileSync(stale, '半截');
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stale, old, old);
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    load.list(false);
    assert.strictEqual(existsSync(stale), false, '列表首读必须顺手清掉过期的遗留临时文件');
  });
});

test('列表：归档后主目录扫不到、带 includeArchived 能读到且带 archived 标记', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    writeFileSync(join(dir, 'b.jsonl'), line('user', { content: '乙' }));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    assert.deepEqual(load.setArchived('a', true), { ok: true });
    const fast = load.list(false) as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      fast.sessions.map((s) => s.sessionId),
      ['b'],
      '快速路径不得含归档会话',
    );
    const full = load.list(true) as { sessions: { sessionId: string; archived: boolean }[] };
    const byId = new Map(full.sessions.map((s) => [s.sessionId, s]));
    assert.strictEqual(byId.get('a')?.archived, true, '归档目录里的会话必须被读出来（可恢复）');
    // 归档会话仍可改名 / 删除（两处路径都要能解析到）
    assert.deepEqual(load.rename('a', '新标题'), { ok: true });
    assert.deepEqual(load.setArchived('a', false), { ok: true });
    assert.strictEqual(existsSync(SessionArchiveLayout.mainFileOf(dir, 'a')), true);
  });
});
