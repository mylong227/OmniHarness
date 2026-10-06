import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionArchive } from '../../src/server/services/session/sessionArchive.js';

// 本文件考的是**扫描 / 排序 / 归档 / 用量**，与工作区作用域无关 —— 故所有 `list` 调用显式传 `'*'`
// （缺省作用域是"当前工作区"，这些夹具的 workspaceRoot 与 fixture 的 workspace 标记并不相同）。
// 作用域本身的判据在 `sessionArchiveWorkspaceScope.test.ts`。

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
      [line('session_meta', { workspace: 'D:\\proj-a' }), line('user', { content: '旧会话' })].join(
        '\n',
      ),
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
    const out = load.list(true, '*') as {
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

test('SessionArchive.list：updatedAt 取**最后一条事件的时间**，不是文件 mtime', () => {
  withTemp((dir) => {
    const file = join(dir, 's1.jsonl');
    writeFileSync(
      file,
      [
        line('session_meta', { workspace: 'D:\\p' }, '2026-09-01T00:00:00.000Z'),
        line('user', { content: '第一句' }, '2026-09-02T00:00:00.000Z'),
        line('assistant', { content: '回复' }, '2026-09-03T08:30:00.000Z'),
      ].join('\n'),
    );
    // 故意把 mtime 设成完全不同的时间：左栏「今天/昨天」分桶用的是事件时间，不能被 mtime 带偏。
    utimesSync(file, new Date('2026-01-01'), new Date('2026-01-01'));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    const out = load.list(true, '*') as { sessions: { updatedAt: string }[] };
    assert.strictEqual(out.sessions[0]?.updatedAt, '2026-09-03T08:30:00.000Z');
  });
});

test('SessionArchive：归档侧车只写名单、不动事件流；列表带 archived 标记', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    writeFileSync(join(dir, 'b.jsonl'), line('user', { content: '乙' }));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    assert.deepEqual(load.setArchived('a', true), { ok: true });
    const out = load.list(true, '*') as {
      sessions: { sessionId: string; archived: boolean; label: string }[];
    };
    const byId = new Map(out.sessions.map((s) => [s.sessionId, s]));
    assert.strictEqual(byId.get('a')?.archived, true);
    assert.strictEqual(byId.get('b')?.archived, false);
    assert.strictEqual(byId.get('a')?.label, '甲', '归档不得影响标签');
    // 取消归档：名单里移除
    assert.deepEqual(load.setArchived('a', false), { ok: true });
    const after = load.list(true, '*') as {
      sessions: { sessionId: string; archived: boolean }[];
    };
    assert.strictEqual(
      after.sessions.every((s) => !s.archived),
      true,
    );
  });
});

test('SessionArchive：归档不存在的会话 → session_not_found；非法 id 同样拒绝', () => {
  withTemp((dir) => {
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    assert.deepEqual(load.setArchived('nope', true), { ok: false, error: 'session_not_found' });
    assert.deepEqual(load.setArchived('../escape', true), {
      ok: false,
      error: 'session_not_found',
    });
  });
});

test('SessionArchive：reorder 登记的用户顺序优先，未登记的按 mtime 倒序排在其后', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    writeFileSync(join(dir, 'b.jsonl'), line('user', { content: '乙' }));
    writeFileSync(join(dir, 'c.jsonl'), line('user', { content: '丙' }));
    utimesSync(join(dir, 'a.jsonl'), new Date('2026-09-03'), new Date('2026-09-03'));
    utimesSync(join(dir, 'b.jsonl'), new Date('2026-09-02'), new Date('2026-09-02'));
    utimesSync(join(dir, 'c.jsonl'), new Date('2026-09-01'), new Date('2026-09-01'));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    assert.deepEqual(load.reorder(['c', 'a']), { ok: true });
    const out = load.list(true, '*') as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      out.sessions.map((s) => s.sessionId),
      ['c', 'a', 'b'],
      '登记过的按用户顺序在前，未登记的（b）按 mtime 倒序垫后',
    );
    assert.deepEqual(load.reorder(['c', '../bad']), { ok: false, error: 'bad_session_id' });
  });
});

test('SessionArchive：排序 v2 —— 另一个客户端新建的会话置顶，不被丢到显式顺序之后', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    writeFileSync(join(dir, 'b.jsonl'), line('user', { content: '乙' }));
    utimesSync(join(dir, 'a.jsonl'), new Date('2026-09-03'), new Date('2026-09-03'));
    utimesSync(join(dir, 'b.jsonl'), new Date('2026-09-02'), new Date('2026-09-02'));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    load.reorder(['a', 'b']);
    // 另一个客户端此刻新建了会话 c（mtime 晚于上次排序时刻）
    writeFileSync(join(dir, 'c.jsonl'), line('user', { content: '丙' }));
    utimesSync(join(dir, 'c.jsonl'), new Date('2030-01-01'), new Date('2030-01-01'));
    const out = load.list(true, '*') as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      out.sessions.map((s) => s.sessionId),
      ['c', 'a', 'b'],
      '新会话必须置顶（在用户显式顺序之前），而不是垫到最后',
    );
  });
});

test('SessionArchive：includeArchived=false 时归档会话整个跳过（不解析事件流）', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    writeFileSync(join(dir, 'b.jsonl'), line('user', { content: '乙' }));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    load.setArchived('a', true);
    const fast = load.list(false, '*') as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      fast.sessions.map((s) => s.sessionId),
      ['b'],
      '快速路径不得包含归档会话',
    );
    const full = load.list(true, '*') as { sessions: { sessionId: string; archived: boolean }[] };
    const byId = new Map(full.sessions.map((s) => [s.sessionId, s]));
    assert.strictEqual(byId.get('a')?.archived, true, '带归档的读取仍要能拿到归档行（可恢复）');
  });
});

test('SessionArchive.list：storageLocation 缺省返回空列表', () => {
  withTemp((dir) => {
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => undefined,
      configuredStorageDir: () => undefined,
    });
    const out = load.list(true, '*') as { dir: string | undefined; sessions: unknown[] };
    assert.strictEqual(out.dir, undefined);
    assert.deepEqual(out.sessions, []);
  });
});

test('SessionArchive：坏行/空行被静默跳过，不影响其余统计', () => {
  withTemp((dir) => {
    writeFileSync(
      join(dir, 's.jsonl'),
      [
        'not-json',
        '',
        line('model', { model: 'm', usage: { promptTokens: 4, completionTokens: 0 } }),
      ].join('\n'),
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
