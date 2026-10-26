import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionArchive } from '../../src/server/services/session/sessionArchive.ts';
import { LocalDay } from '../../src/util/localDay.ts';

// 本文件考的是**扫描 / 排序 / 归档 / 用量**，与工作区作用域无关 —— 故所有 `list` 调用显式传 `'*'`
// （缺省作用域是"当前工作区"，这些夹具的 workspaceRoot 与 fixture 的 workspace 标记并不相同）。
// 作用域本身的判据在 `sessionArchiveWorkspaceScope.test.ts`。

/** 在临时目录内执行（支持 async 回调：list/usage 自 2026-10-18 起是异步 IO）。 */
async function withTemp<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'session-archive-'));
  try {
    return await fn(dir);
  } finally {
    // 旁路摘要/索引写入是异步的：清理与最后一次写可能擦肩，Windows 上会 ENOTEMPTY；
    // 有界重试而非硬失败（判据本身已结束，清理不应把绿判红）。
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/** 写一行 JSONL 事件。 */
function line(type: string, payload: unknown, timestamp = '2026-09-11T00:00:00.000Z'): string {
  return JSON.stringify({ id: 'e', type, sessionId: 's', timestamp, payload });
}

test('SessionArchive.list：mock 会话默认不列出；摘要带有效时长与空闲间隔', async () => {
  await withTemp(async (dir) => {
    writeFileSync(
      join(dir, 'real.jsonl'),
      [
        line(
          'session_meta',
          { workspace: dir, model: 'deepseek-v4-flash' },
          '2026-09-11T00:00:00.000Z',
        ),
        line('user', { content: '真实任务' }, '2026-09-11T00:00:00.000Z'),
        line(
          'model',
          { model: 'deepseek-v4-flash', usage: { promptTokens: 1, completionTokens: 1 } },
          '2026-09-11T00:00:10.000Z',
        ),
        // 用户离开 1 小时再回来：必须从有效时长里剔除，但计入 idleGaps。
        line('user', { content: '一小时后回来' }, '2026-09-11T01:00:10.000Z'),
        line('assistant', { content: 'done' }, '2026-09-11T01:00:15.000Z'),
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'mock.jsonl'),
      [
        line('session_meta', { workspace: dir }, '2026-09-11T00:00:00.000Z'),
        line('user', { content: 'hi' }, '2026-09-11T00:00:00.000Z'),
        line(
          'tool_call',
          { callId: 'mock_call_1', name: 'shell', args: { command: 'echo x' } },
          '2026-09-11T00:00:00.000Z',
        ),
        line(
          'tool_result',
          { callId: 'mock_call_1', ok: true, output: 'x' },
          '2026-09-11T00:00:01.000Z',
        ),
        line(
          'assistant',
          { content: '任务完成（模拟模型适配器输出）' },
          '2026-09-11T00:00:01.000Z',
        ),
      ].join('\n'),
    );
    const archive = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    const visible = (await archive.list(true, '*')) as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      visible.sessions.map((s) => s.sessionId),
      ['real'],
      'mock 会话默认隐藏',
    );

    const all = (await archive.list(true, '*', true)) as {
      sessions: { sessionId: string; mock: boolean; activeMs: number; idleGaps: number }[];
    };
    assert.deepEqual(
      all.sessions.map((s) => s.sessionId).sort(),
      ['mock', 'real'],
      'includeMock=true 时两者都在',
    );
    const real = all.sessions.find((s) => s.sessionId === 'real');
    assert.strictEqual(real?.mock, false);
    assert.strictEqual(real?.idleGaps, 1);
    assert.strictEqual(real?.activeMs, 15_000, '有效时长 = 10s + 5s，不含 1 小时空闲');
    assert.strictEqual(all.sessions.find((s) => s.sessionId === 'mock')?.mock, true);
  });
});

test('SessionArchive.dailyUsage：按文件戳缓存，追加事件后必须失效', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 's1.jsonl');
    writeFileSync(
      file,
      line(
        'model',
        { model: 'm', usage: { promptTokens: 10, completionTokens: 5 } },
        '2026-09-11T00:00:00.000Z',
      ),
    );
    const archive = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    const day = new LocalDay(new Date('2026-09-11T12:00:00'));
    assert.strictEqual(archive.dailyUsage(day).total, 15);
    // 同一天追加一条：mtime/size 变化 ⇒ 缓存必须失效（否则「今日用量」永远停在上一次读数）。
    writeFileSync(
      file,
      [
        line(
          'model',
          { model: 'm', usage: { promptTokens: 10, completionTokens: 5 } },
          '2026-09-11T00:00:00.000Z',
        ),
        line(
          'model',
          { model: 'm', usage: { promptTokens: 2, completionTokens: 3 } },
          '2026-09-11T01:00:00.000Z',
        ),
      ].join('\n'),
    );
    assert.strictEqual(archive.dailyUsage(day).total, 20);
  });
});

test('SessionArchive.usage：聚合磁盘 model 事件为 byModel 与 per-session 统计', async () => {
  await withTemp(async (dir) => {
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
    const out = (await load.usage()) as {
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

test('SessionArchive.usage：缓存按 mtime 失效——追加 model 事件后重新统计，不得读到旧值', async () => {
  await withTemp(async (dir) => {
    const file = join(dir, 's1.jsonl');
    writeFileSync(
      file,
      line('model', { model: 'm', usage: { promptTokens: 1, completionTokens: 1 } }),
    );
    const archive = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    const first = (await archive.usage()) as { total: { calls: number; total: number } };
    assert.strictEqual(first.total.calls, 1);
    assert.strictEqual(first.total.total, 2);

    // 追加一条 model 事件（同一次会话继续对话）：mtime/size 变化 ⇒ 缓存必须失效。
    writeFileSync(
      file,
      [
        line('model', { model: 'm', usage: { promptTokens: 1, completionTokens: 1 } }),
        line('model', { model: 'm', usage: { promptTokens: 10, completionTokens: 5 } }),
      ].join('\n'),
    );
    const second = (await archive.usage()) as { total: { calls: number; total: number } };
    assert.strictEqual(second.total.calls, 2, '追加事件后 calls 必须变成 2（缓存未失效会仍是 1）');
    assert.strictEqual(
      second.total.total,
      17,
      '追加事件后 total 必须是 2 + 15（缓存未失效会仍是 2）',
    );
  });
});

test('SessionArchive.usage：磁盘无数据时回退 live 且指标为空', async () => {
  await withTemp(async (dir) => {
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => join(dir, 'empty'),
      configuredStorageDir: () => undefined,
    });
    const out = (await load.usage()) as { source: string; total: { calls: number } };
    assert.strictEqual(out.source, 'live');
    assert.strictEqual(out.total.calls, 0);
  });
});

test('SessionArchive.usage：storageLocation 缺省时按工作区 + storageDir 推断', async () => {
  await withTemp(async (dir) => {
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
    const out = (await load.usage()) as { source: string; dir: string };
    assert.strictEqual(out.source, 'disk');
    assert.strictEqual(join(out.dir), join(dir, 'store'));
  });
});

test('SessionArchive.list：提取工作区标记与首条用户消息，按 mtime 倒序', async () => {
  await withTemp(async (dir) => {
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
    const out = (await load.list(true, '*')) as {
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

test('SessionArchive.list：updatedAt 取**最后一条事件的时间**，不是文件 mtime', async () => {
  await withTemp(async (dir) => {
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
    const out = (await load.list(true, '*')) as { sessions: { updatedAt: string }[] };
    assert.strictEqual(out.sessions[0]?.updatedAt, '2026-09-03T08:30:00.000Z');
  });
});

test('SessionArchive：归档侧车只写名单、不动事件流；列表带 archived 标记', async () => {
  await withTemp(async (dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    writeFileSync(join(dir, 'b.jsonl'), line('user', { content: '乙' }));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    assert.deepEqual(load.setArchived('a', true), { ok: true });
    const out = (await load.list(true, '*')) as {
      sessions: { sessionId: string; archived: boolean; label: string }[];
    };
    const byId = new Map(out.sessions.map((s) => [s.sessionId, s]));
    assert.strictEqual(byId.get('a')?.archived, true);
    assert.strictEqual(byId.get('b')?.archived, false);
    assert.strictEqual(byId.get('a')?.label, '甲', '归档不得影响标签');
    // 取消归档：名单里移除
    assert.deepEqual(load.setArchived('a', false), { ok: true });
    const after = (await load.list(true, '*')) as {
      sessions: { sessionId: string; archived: boolean }[];
    };
    assert.strictEqual(
      after.sessions.every((s) => !s.archived),
      true,
    );
  });
});

test('SessionArchive：归档不存在的会话 → session_not_found；非法 id 同样拒绝', async () => {
  await withTemp(async (dir) => {
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

test('SessionArchive：reorder 登记的用户顺序优先，未登记的按 mtime 倒序排在其后', async () => {
  await withTemp(async (dir) => {
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
    const out = (await load.list(true, '*')) as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      out.sessions.map((s) => s.sessionId),
      ['c', 'a', 'b'],
      '登记过的按用户顺序在前，未登记的（b）按 mtime 倒序垫后',
    );
    assert.deepEqual(load.reorder(['c', '../bad']), { ok: false, error: 'bad_session_id' });
  });
});

test('SessionArchive：排序 v2 —— 另一个客户端新建的会话置顶，不被丢到显式顺序之后', async () => {
  await withTemp(async (dir) => {
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
    const out = (await load.list(true, '*')) as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      out.sessions.map((s) => s.sessionId),
      ['c', 'a', 'b'],
      '新会话必须置顶（在用户显式顺序之前），而不是垫到最后',
    );
  });
});

test('SessionArchive：includeArchived=false 时归档会话整个跳过（不解析事件流）', async () => {
  await withTemp(async (dir) => {
    writeFileSync(join(dir, 'a.jsonl'), line('user', { content: '甲' }));
    writeFileSync(join(dir, 'b.jsonl'), line('user', { content: '乙' }));
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => dir,
      configuredStorageDir: () => undefined,
    });
    load.setArchived('a', true);
    const fast = (await load.list(false, '*')) as { sessions: { sessionId: string }[] };
    assert.deepEqual(
      fast.sessions.map((s) => s.sessionId),
      ['b'],
      '快速路径不得包含归档会话',
    );
    const full = (await load.list(true, '*')) as {
      sessions: { sessionId: string; archived: boolean }[];
    };
    const byId = new Map(full.sessions.map((s) => [s.sessionId, s]));
    assert.strictEqual(byId.get('a')?.archived, true, '带归档的读取仍要能拿到归档行（可恢复）');
  });
});

test('SessionArchive.list：storageLocation 缺省返回空列表', async () => {
  await withTemp(async (dir) => {
    const load = new SessionArchive({
      workspaceRoot: () => dir,
      storageLocation: () => undefined,
      configuredStorageDir: () => undefined,
    });
    const out = (await load.list(true, '*')) as { dir: string | undefined; sessions: unknown[] };
    assert.strictEqual(out.dir, undefined);
    assert.deepEqual(out.sessions, []);
  });
});

test('SessionArchive：坏行/空行被静默跳过，不影响其余统计', async () => {
  await withTemp(async (dir) => {
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
    const out = (await load.usage()) as { source: string; total: { calls: number; total: number } };
    assert.strictEqual(out.source, 'disk');
    assert.strictEqual(out.total.calls, 1);
    assert.strictEqual(out.total.total, 4);
  });
});
