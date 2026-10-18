import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessRewardStore } from '../../src/adapters/memory/processRewardStore.ts';

/** 固定时间。 */
const at = '2026-10-18T00:00:00.000Z';

test('过程奖励：通过率、AUC、Brier、Laplace 先验', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-process-reward-'));
  try {
    const store = new ProcessRewardStore(dir, { path: join(dir, 'rewards.jsonl') });
    await store.record({
      toolName: 'write_file',
      targets: ['a.ts'],
      noul: 0.9,
      passed: true,
      exitCode: 0,
      at,
    });
    await store.record({
      toolName: 'write_file',
      targets: ['a.ts'],
      noul: 0.8,
      passed: true,
      exitCode: 0,
      at,
    });
    await store.record({
      toolName: 'write_file',
      targets: ['a.ts'],
      noul: 0.2,
      passed: false,
      exitCode: 1,
      at,
    });
    await store.record({
      toolName: 'write_file',
      targets: ['a.ts'],
      noul: 0.3,
      passed: false,
      exitCode: 1,
      at,
    });
    const stats = await store.stats();
    assert.strictEqual(stats.samples, 4);
    assert.strictEqual(stats.passes, 2);
    assert.strictEqual(stats.passRate, 0.5);
    assert.strictEqual(stats.withNoul, 4);
    assert.strictEqual(stats.auc, 1, '完美区分时应为 1');
    assert.ok(stats.brier > 0);
    assert.ok(stats.lift > 0);
    assert.strictEqual(await store.predict('write_file'), 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('过程奖励：无 noul 时 AUC/Brier/lift 为 NaN，不伪造数字', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-process-reward-no-noul-'));
  try {
    const store = new ProcessRewardStore(dir, { path: join(dir, 'rewards.jsonl') });
    await store.record({ toolName: 'edit', targets: ['a.ts'], passed: true, exitCode: 0, at });
    const stats = await store.stats();
    assert.strictEqual(stats.samples, 1);
    assert.strictEqual(stats.withNoul, 0);
    assert.ok(Number.isNaN(stats.auc));
    assert.ok(Number.isNaN(stats.brier));
    assert.ok(Number.isNaN(stats.lift));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('过程奖励：按工具隔离先验，超出上限淘汰最旧', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-process-reward-bound-'));
  try {
    const store = new ProcessRewardStore(dir, { maxEntries: 1, path: join(dir, 'rewards.jsonl') });
    await store.record({ toolName: 'a', targets: [], passed: false, exitCode: 1, at });
    await store.record({ toolName: 'a', targets: [], passed: true, exitCode: 0, at });
    await store.record({ toolName: 'b', targets: [], passed: true, exitCode: 0, at });
    assert.strictEqual((await store.stats()).samples, 1);
    assert.strictEqual(await store.predict('b'), 2 / 3, 'b 只有 1 条通过：Laplace (1+1)/(1+2)');
    assert.strictEqual(await store.predict('a'), 1 / 2, 'a 的样本已被淘汰：无样本 ⇒ 0.5');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
