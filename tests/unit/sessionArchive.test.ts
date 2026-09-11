import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionArchive } from '../../src/server/sessionArchive.js';

/** 在临时目录内执行。 */
function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'session-archive-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 写一行 JSONL 事件。 */
function line(type: string, payload: unknown, timestamp = '2026-09-11T00:00:00.000Z'): string {
  return JSON.stringify({ id: 'e', type, sessionId: 's', timestamp, payload });
}

test('SessionArchive.usage：聚合磁盘 model 事件为 byModel 与 per-session 统计', () => {
  withTemp((dir) => {
    writeFileSync(
      join(dir, 's1.jsonl'),
      [
        line('model', { model: 'gpt-x', usage: { promptTokens: 10, completionTokens: 5 } }),
        line('user', { content: 'hi' }),
        line('model', { model: 'gpt-x', usage: { promptTokens: 2, completionTokens: 3 } }),
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 's2.jsonl'),
      line('model', { model: 'claude-y', usage: { promptTokens: 100, completionTokens: 1 } }),
    );
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    const out = load.usage() as {
      source: string;
      byModel: Record<string, { calls: number; prompt: number; completion: number; total: number }>;
      total: { calls: number; total: number };
      sessions: { sessionId: string; calls: number; total: number }[];
    };
    assert.strictEqual(out.source, 'disk');
    assert.deepEqual(out.byModel['gpt-x'], { calls: 2, prompt: 12, completion: 8, total: 20 });
    assert.deepEqual(out.byModel['claude-y'], { calls: 1, prompt: 100, completion: 1, total: 101 });
    assert.strictEqual(out.total.calls, 3);
    assert.strictEqual(out.total.total, 121);
    // 会话按 total 倒序：s2(101) 在 s1(20) 前。
    assert.deepEqual(
      out.sessions.map((s) => s.sessionId),
      ['s2', 's1'],
    );
  });
});

test('SessionArchive.usage：磁盘无数据时回退 live 且指标为空', () => {
  withTemp((dir) => {
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => join(dir, 'empty'),
      configuredStorageDir: () => undefined,
    });
    const out = load.usage() as { source: string; total: { calls: number } };
    assert.strictEqual(out.source, 'live');
    assert.strictEqual(out.total.calls, 0);
  });
});

test('SessionArchive.usage：storageLocation 缺省时按工作区 + storageDir 推断', () => {
  withTemp((dir) => {
    mkdirSync(join(dir, 'store'));
    writeFileSync(
      join(dir, 'store', 's.jsonl'),
      line('model', { model: 'm', usage: { promptTokens: 1, completionTokens: 1 } }),
    );
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => undefined,
      configuredStorageDir: () => 'store',
    });
    const out = load.usage() as { source: string; dir: string };
    assert.strictEqual(out.source, 'disk');
    assert.strictEqual(join(out.dir), join(dir, 'store'));
  });
});

test('SessionArchive.list：提取工作区标记与首条用户消息，按 mtime 倒序', () => {
  withTemp((dir) => {
    const oldFile = join(dir, 'old.jsonl');
    const newFile = join(dir, 'new.jsonl');
    writeFileSync(
      oldFile,
      [line('session_meta', { workspace: 'D:\\proj-a' }), line('user', { content: '旧会话' })].join('\n'),
    );
    writeFileSync(
      newFile,
      [
        line('session_meta', { workspace: 'D:\\proj-b' }),
        line('user', { content: '新会话第一条' }),
        line('user', { content: '第二条' }),
      ].join('\n'),
    );
    utimesSync(oldFile, new Date('2026-09-01'), new Date('2026-09-01'));
    utimesSync(newFile, new Date('2026-09-10'), new Date('2026-09-10'));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    const out = load.list() as {
      sessions: { sessionId: string; workspace?: string; label: string; turns: number }[];
    };
    assert.deepEqual(
      out.sessions.map((s) => s.sessionId),
      ['new', 'old'],
    );
    assert.strictEqual(out.sessions[0]?.workspace, 'D:\\proj-b');
    assert.strictEqual(out.sessions[0]?.label, '新会话第一条');
    assert.strictEqual(out.sessions[0]?.turns, 2);
    assert.strictEqual(out.sessions[1]?.workspace, 'D:\\proj-a');
  });
});

test('SessionArchive.list：storageLocation 缺省返回空列表', () => {
  withTemp((dir) => {
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => undefined,
      configuredStorageDir: () => undefined,
    });
    const out = load.list() as { dir: string | undefined; sessions: unknown[] };
    assert.strictEqual(out.dir, undefined);
    assert.deepEqual(out.sessions, []);
  });
});

test('SessionArchive：坏行/空行被静默跳过，不影响其余统计', () => {
  withTemp((dir) => {
    writeFileSync(
      join(dir, 's.jsonl'),
      ['not-json', '', line('model', { model: 'm', usage: { promptTokens: 4, completionTokens: 0 } })].join('\n'),
    );
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    const out = load.usage() as { source: string; total: { calls: number; total: number } };
    assert.strictEqual(out.source, 'disk');
    assert.strictEqual(out.total.calls, 1);
    assert.strictEqual(out.total.total, 4);
  });
});
