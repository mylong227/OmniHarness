/**
 * 会话基线文本存储判据：命中、按路径失效、单条上限、全局 LRU 淘汰。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SessionBaselineStore } from '../../src/adapters/tool/fs/sessionBaselineStore.ts';

test('① set/get：按 (路径, 会话) 隔离，互不串基线', () => {
  const store = new SessionBaselineStore();
  store.set('/a', 's1', 'one');
  store.set('/a', 's2', 'two');
  assert.strictEqual(store.get('/a', 's1'), 'one');
  assert.strictEqual(store.get('/a', 's2'), 'two');
  assert.strictEqual(store.get('/b', 's1'), undefined);
});

test('② deletePath 只清该路径的所有会话基线', () => {
  const store = new SessionBaselineStore();
  store.set('/a', 's1', 'one');
  store.set('/a', 's2', 'two');
  store.set('/b', 's1', 'three');
  store.deletePath('/a');
  assert.strictEqual(store.get('/a', 's1'), undefined);
  assert.strictEqual(store.get('/a', 's2'), undefined);
  assert.strictEqual(store.get('/b', 's1'), 'three');
});

test('③ 单条超限 ⇒ 不保存（调用方退回保守路径）', () => {
  const store = new SessionBaselineStore({ maxEntryBytes: 8 });
  store.set('/a', 's1', '123456789');
  assert.strictEqual(store.get('/a', 's1'), undefined);
  assert.strictEqual(store.size(), 0);
});

test('④ 全局预算：超出按 LRU 淘汰最旧，且命中会提升', () => {
  const store = new SessionBaselineStore({ maxBytes: 12, maxEntryBytes: 12 });
  store.set('/a', 's1', '1234'); // 4
  store.set('/b', 's1', '5678'); // 8
  store.set('/c', 's1', 'abcd'); // 12
  assert.strictEqual(store.get('/a', 's1'), '1234'); // 提升 /a
  store.set('/d', 's1', 'wxyz'); // 16 > 12，淘汰最旧 /b
  assert.strictEqual(store.get('/b', 's1'), undefined);
  assert.strictEqual(store.get('/a', 's1'), '1234');
  assert.strictEqual(store.get('/c', 's1'), 'abcd');
  assert.strictEqual(store.get('/d', 's1'), 'wxyz');
  assert.ok(store.sizeBytes() <= 12);
});
