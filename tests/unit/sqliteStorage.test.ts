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
