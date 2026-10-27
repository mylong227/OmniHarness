/**
 * A2A 任务表边界判据（2026-10-27 审计收口）：任务总量上限淘汰、单任务产出上限。
 *
 * 背景：records/artifacts 此前无上限——每个 `message/send`（远端可控的唯一 id）永久占
 * 一条记录，长跑 serve 即远程内存耗尽向量。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { A2aTaskStore } from '../../src/a2a/a2aTaskStore.ts';

test('任务总量上限：超出先淘汰终态任务，非终态保留到最后', () => {
  // 上限在构造期读取 ⇒ 先设 env 再建实例。
  process.env['OMNI_A2A_MAX_TASKS'] = '4';
  const store = new A2aTaskStore();
  try {
    store.create('t-done-1');
    store.update('t-done-1', { state: 'completed' });
    store.create('t-live-1');
    store.create('t-done-2');
    store.update('t-done-2', { state: 'failed' });
    store.create('t-live-2');
    // 第 5 个任务进表 ⇒ 必须恰好淘汰一个**终态**任务（而非最老的 t-live-1）。
    store.create('t-new');
    assert.strictEqual(store.get('t-done-1'), undefined, '最老的终态任务应被淘汰');
    assert.ok(store.get('t-done-2') !== undefined, '只淘汰到上限即停');
    assert.ok(store.get('t-live-1') !== undefined, '非终态任务不得先于终态被淘汰');
    assert.ok(store.get('t-live-2') !== undefined);
    assert.ok(store.get('t-new') !== undefined);
    // 第 6 个任务 ⇒ 淘汰次老的终态任务。
    store.create('t-new2');
    assert.strictEqual(store.get('t-done-2'), undefined, '次老的终态任务应被淘汰');
    assert.ok(store.get('t-live-1') !== undefined);
    assert.ok(store.get('t-new2') !== undefined);
  } finally {
    delete process.env['OMNI_A2A_MAX_TASKS'];
  }
});

test('任务总量上限：无终态可淘汰时淘汰最老的非终态任务（有界内存优先）', () => {
  process.env['OMNI_A2A_MAX_TASKS'] = '2';
  const store = new A2aTaskStore();
  try {
    store.create('a');
    store.create('b');
    store.create('c');
    assert.strictEqual(store.get('a'), undefined, '最老任务被淘汰以守住上限');
    assert.ok(store.get('b') !== undefined);
    assert.ok(store.get('c') !== undefined);
    assert.ok(store.list().length <= 2);
  } finally {
    delete process.env['OMNI_A2A_MAX_TASKS'];
  }
});

test('单任务产出上限：超出丢最旧并保留最新', () => {
  process.env['OMNI_A2A_MAX_ARTIFACTS_PER_TASK'] = '3';
  const store = new A2aTaskStore();
  try {
    store.create('t');
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      store.update('t', { artifact: { name, parts: [] } });
    }
    const task = store.require('t');
    const names = (task.artifacts ?? []).map((a) => a.name);
    assert.deepStrictEqual(names, ['a3', 'a4', 'a5'], '超出上限的最旧产出被丢弃');
  } finally {
    delete process.env['OMNI_A2A_MAX_ARTIFACTS_PER_TASK'];
  }
});

test('终态语义不变：completed/failed/canceled/rejected 为终态', () => {
  assert.strictEqual(A2aTaskStore.isTerminal('completed'), true);
  assert.strictEqual(A2aTaskStore.isTerminal('failed'), true);
  assert.strictEqual(A2aTaskStore.isTerminal('canceled'), true);
  assert.strictEqual(A2aTaskStore.isTerminal('rejected'), true);
  assert.strictEqual(A2aTaskStore.isTerminal('working'), false);
  assert.strictEqual(A2aTaskStore.isTerminal('submitted'), false);
});
