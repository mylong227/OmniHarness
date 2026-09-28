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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
