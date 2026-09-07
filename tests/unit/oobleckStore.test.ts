import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OobleckStore } from '../../src/adapters/kv/oobleckStore.js';
import { MemoryKv } from '../../src/adapters/kv/memoryKv.js';

/** 新建一个默认 τ=0.6 的 OobleckStore（内存后端）。 */
function makeStore(yieldStress = 0.6): OobleckStore {
  return new OobleckStore(new MemoryKv(), { yieldStress });
}

test('燧-2：液态下温和写入可反复覆盖（rig 保持松弛）', async () => {
  const store = makeStore();
  for (let i = 0; i < 6; i++) {
    const r = await store.propose('fact', `v${i}`, 0.1); // impact < τ
    assert.strictEqual(r.accepted, true);
    assert.strictEqual(r.frozen, false);
    assert.strictEqual(r.reason, 'liquid');
  }
  const rec = await store.get('fact');
  assert.strictEqual(rec?.value, 'v5'); // 最后一次覆盖生效
  assert.strictEqual(rec?.frozen, false);
  assert.strictEqual(await store.isFrozen('fact'), false);
});

test('燧-2：冲击越过屈服应力 → 提交并冻结（涌现，非显式调用）', async () => {
  const store = makeStore(0.6);
  await store.propose('fact', 'liquid', 0.1);
  const r = await store.propose('fact', 'CRITICAL', 1.5); // impact >= τ
  assert.strictEqual(r.accepted, true);
  assert.strictEqual(r.frozen, true); // 冻结是冲击涌现的
  assert.strictEqual(r.reason, 'yield');
  const rec = await store.get('fact');
  assert.strictEqual(rec?.value, 'CRITICAL');
  assert.strictEqual(rec?.frozen, true);
  assert.strictEqual(await store.isFrozen('fact'), true);
});

test('燧-2：冻结后写入被拒绝（fail-closed 不可变）', async () => {
  const store = makeStore(0.6);
  await store.propose('fact', 'CRITICAL', 1.5); // 冻结
  const after = await store.propose('fact', 'tampered', 0.1); // 冻结后再写
  assert.strictEqual(after.accepted, false);
  assert.strictEqual(after.frozen, true);
  assert.strictEqual(after.reason, 'frozen');
  // 值未被篡改
  assert.strictEqual((await store.get('fact'))?.value, 'CRITICAL');
});

test('燧-2：冻结后删除被拒绝（不可变）', async () => {
  const store = makeStore(0.6);
  await store.propose('fact', 'CRITICAL', 1.5); // 冻结
  const deleted = await store.delete('fact');
  assert.strictEqual(deleted, false); // 冻结 = 不可变，删除同样拒绝
  assert.strictEqual(await store.isFrozen('fact'), true);
  assert.strictEqual((await store.get('fact'))?.value, 'CRITICAL');
});

test('燧-2：液态下删除允许', async () => {
  const store = makeStore(0.6);
  await store.propose('fact', 'liquid', 0.1);
  const deleted = await store.delete('fact');
  assert.strictEqual(deleted, true);
  assert.strictEqual(await store.get('fact'), undefined);
});

test('燧-2：阈值可配置，且边界精确（impact === τ 即冻结）', async () => {
  const store = makeStore(0.6);
  const onBoundary = await store.propose('k', 'x', 0.6); // impact === τ
  assert.strictEqual(onBoundary.frozen, true);
  const below = await store.propose('k2', 'y', 0.599); // 严格小于
  assert.strictEqual(below.frozen, false);
});
