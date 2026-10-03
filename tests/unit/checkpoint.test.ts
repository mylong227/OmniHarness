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

// ---- 2026-10-03 回归（审计 P1）：索引在、载荷丢 ⇒ 绝不能用空/残缺快照覆盖主会话 ----
test('rollback：检查点载荷丢失时抛错且主会话不被清空（fail-closed）', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage);
  const sid = 's-lost';
  await storage.save(sid, events(3, sid));
  await mgr.snapshot(sid, 'cp1');
  // 现在主会话继续演进，然后检查点载荷被清（清理脚本/损坏/jsonl 坏行全跳的等价形态）
  await storage.save(sid, events(7, sid));
  const current = await storage.load(sid);
  await storage.save('checkpoint:s-lost:cp1', []);
  await assert.rejects(() => mgr.rollback(sid), /载荷缺失或损坏/);
  const after = await storage.load(sid);
  assert.deepStrictEqual(after, current, '主会话历史必须原样保留');
});

test('rollback：事件数与 meta 不一致时抛错（半截载荷拒绝覆盖）', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage);
  const sid = 's-partial';
  await storage.save(sid, events(3, sid));
  await mgr.snapshot(sid, 'cp1');
  // 载荷被截去一半（jsonl 坏行跳过的等价形态）
  await storage.save('checkpoint:s-partial:cp1', events(1, 'checkpoint:s-partial:cp1'));
  await assert.rejects(() => mgr.rollback(sid), /载荷缺失或损坏/);
});

// ---- 2026-09-22 回归（审计 P2）：label / sessionId 路径穿越必须被拒 ----
test('checkpoint：非法 label 被拒（路径穿越 fail-closed）', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage, { workspaceRoot: process.cwd() });
  const sid = 's_traversal';
  await storage.save(sid, events(1, sid));
  for (const bad of ['../../evil', '..\\..\\evil', 'a/b', 'a\\b', '', 'x'.repeat(65), 'a.b']) {
    await assert.rejects(
      () => mgr.snapshot(sid, bad),
      /label 非法/,
      `label=${JSON.stringify(bad)} 应被白名单拒绝`,
    );
  }
});

test('checkpoint：非法 sessionId 被拒（会话 id 同样拼进路径）', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage, { workspaceRoot: process.cwd() });
  await assert.rejects(() => mgr.snapshot('../outside', 'ok'), /sessionId 非法/);
});

test('checkpoint：合法 label 仍可用（不过度收紧）', async () => {
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage, { workspaceRoot: process.cwd() });
  const sid = 's_ok';
  await storage.save(sid, events(2, sid));
  const meta = await mgr.snapshot(sid, 'before-refactor_2');
  assert.strictEqual(meta.label, 'before-refactor_2');
  await assert.rejects(() => mgr.snapshot(sid, 'bad label with spaces'), /label 非法/);
});

test('checkpoint 工具层：模型可控的 label 被白名单拒绝（纵深防御第一道）', async () => {
  const { CheckpointTool } = await import('../../src/adapters/tool/git/checkpointTool.js');
  const storage = new MemoryStorage();
  const mgr = new CheckpointManager(storage, { workspaceRoot: process.cwd() });
  const handler = CheckpointTool.makeCheckpointHandler(mgr);
  const ctx = { sessionId: 's_tool', callId: 'c1', workspaceRoot: process.cwd() } as never;
  const bad = await handler(
    { id: 'c1', name: 'checkpoint', arguments: { label: '../../../../tmp/evil' } },
    ctx,
  );
  assert.strictEqual(bad.ok, false);
  assert.match(String(bad.error), /label 非法/);
  const good = await handler(
    { id: 'c2', name: 'checkpoint', arguments: { label: 'before-refactor' } },
    ctx,
  );
  assert.strictEqual(good.ok, true);
});
