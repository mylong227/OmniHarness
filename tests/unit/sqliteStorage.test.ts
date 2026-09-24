import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../../src/adapters/storage/sqliteStorage.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 构造事件。 */
function events(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `e${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { content: `消息 ${index}` },
  }));
}

test('SQLite：保存后可完整加载且顺序一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const file = join(dir, 'test.db');
  try {
    const storage = new SqliteStorage(file);
    await storage.save('s1', events(4));
    const loaded = await storage.load('s1');
    assert.strictEqual(loaded.length, 4);
    assert.deepStrictEqual(loaded[0]?.payload, events(4)[0]?.payload);
    assert.deepStrictEqual(loaded[3]?.payload, events(4)[3]?.payload);
    storage.close();
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows node:sqlite 句柄释放延迟，忽略 */
    }
  }
});

test('SQLite：覆盖保存替换旧事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const file = join(dir, 'test.db');
  try {
    const storage = new SqliteStorage(file);
    await storage.save('s1', events(4));
    await storage.save('s1', events(2));
    const loaded = await storage.load('s1');
    assert.strictEqual(loaded.length, 2);
    storage.close();
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows node:sqlite 句柄释放延迟，忽略 */
    }
  }
});

test('SQLite：多会话隔离', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const file = join(dir, 'test.db');
  try {
    const storage = new SqliteStorage(file);
    await storage.save('a', events(2));
    await storage.save('b', events(3));
    assert.strictEqual((await storage.load('a')).length, 2);
    assert.strictEqual((await storage.load('b')).length, 3);
    assert.strictEqual((await storage.load('missing')).length, 0);
    storage.close();
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* Windows node:sqlite 句柄释放延迟，忽略 */
    }
  }
});

// ---- 2026-09-24（审计 §2.5：DELETE + 逐条 INSERT 无事务）----

test('SQLite：写入中途失败必须整体回滚，旧快照不被半截覆盖（审计 §2.5 回归）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const file = join(dir, 'test.db');
  try {
    const storage = new SqliteStorage(file);
    const original = events(3);
    await storage.save('s1', original);

    // 第 2 条事件的 payload 含循环引用 ⇒ JSON.stringify 在写入**中途**抛错。
    // 原实现（无事务）此时 DELETE 已提交、新快照只写了一半 ⇒ 历史变半截；
    // 现实现必须回滚到写入前的旧快照。
    const broken = events(3);
    const cyclic: Record<string, unknown> = { content: '环' };
    cyclic['self'] = cyclic;
    broken[1] = { ...(broken[1] as SessionEvent), payload: cyclic };

    await assert.rejects(() => storage.save('s1', broken), '写入失败必须如实抛错（不静默）');
    const loaded = await storage.load('s1');
    assert.strictEqual(loaded.length, 3, '回滚后应仍是写入前的旧快照');
    assert.deepStrictEqual(
      loaded.map((e) => e.id),
      ['e0', 'e1', 'e2'],
    );
    storage.close();
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows node:sqlite 句柄释放延迟，忽略 */
    }
  }
});

test('SQLite：单事务批量写入在规模上明显快于逐条自动提交（实测口径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omniharness-'));
  const file = join(dir, 'test.db');
  try {
    const storage = new SqliteStorage(file);
    const batch = events(500);
    // 预热 + 计时（只断言「够快」的宽松上界：事务化的 500 条应在数十毫秒量级）
    await storage.save('warm', batch);
    const began = Date.now();
    await storage.save('s1', batch);
    const elapsed = Date.now() - began;
    assert.strictEqual((await storage.load('s1')).length, 500);
    assert.ok(elapsed < 500, `500 事件写入应在 500ms 内完成，实测 ${String(elapsed)}ms`);
    storage.close();
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows node:sqlite 句柄释放延迟，忽略 */
    }
  }
});
