import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointManager } from '../../src/core/checkpointManager.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 构造若干事件，便于断言回滚后事件被精确恢复。 */
function events(n: number, sessionId: string): SessionEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    type: 'user' as const,
    sessionId,
    timestamp: `2024-01-01T00:00:0${i}.000Z`,
    payload: { i },
  }));
}

test('snapshot 后 rollback 能恢复 events', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage);
  const sid = 's1';
  const original = events(3, sid);
  await storage.save(sid, original);

  const meta = await mgr.snapshot(sid, 'cp1');
  assert.strictEqual(meta.eventCount, 3);

  // 模拟会话演进：追加事件
  await storage.save(sid, events(5, sid));

  const rolled = await mgr.rollback(sid);
  assert.strictEqual(rolled.label, 'cp1');
  const after = await storage.load(sid);
  assert.deepStrictEqual(after, original);
});

test('snapshot 多次后 list 数量正确', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage);
  const sid = 's2';
  await storage.save(sid, events(1, sid));
  await mgr.snapshot(sid, 'a');
  await mgr.snapshot(sid, 'b');
  await mgr.snapshot(sid, 'c');

  const list = await mgr.list(sid);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(
    list.map((m) => m.label),
    ['a', 'b', 'c'],
  );
});

test('rollback 到指定 label 正确', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage);
  const sid = 's3';
  await storage.save(sid, events(2, sid));
  await mgr.snapshot(sid, 'first');
  await storage.save(sid, events(4, sid));
  await mgr.snapshot(sid, 'second');

  // 当前演进
  await storage.save(sid, events(9, sid));
  const rolled = await mgr.rollback(sid, 'first');
  assert.strictEqual(rolled.label, 'first');
  const after = await storage.load(sid);
  assert.strictEqual(after.length, 2);
});

test('无快照 rollback 抛错（fail-closed）', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage);
  await assert.rejects(
    () => mgr.rollback('never'),
    (err: Error) => err.message === '无可用检查点',
  );
});
