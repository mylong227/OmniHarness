import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowMemoryStore } from '../../src/adapters/memory/workflowMemoryStore.ts';

/** 固定时钟。 */
const now = (): Date => new Date('2026-10-18T00:00:00.000Z');

test('workflow memory：记录、去重、按任务重叠召回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-workflows-'));
  try {
    const store = new WorkflowMemoryStore(dir, { now, path: join(dir, 'workflows.jsonl') });
    await store.remember('修复登录接口的鉴权 bug', [
      'read_file src/auth.ts',
      'apply_patch fix auth',
    ]);
    await store.remember('修复登录接口的鉴权 bug', [
      'read_file src/auth.ts',
      'apply_patch fix auth',
    ]);
    await store.remember('给 README 增加安装说明', ['read_file README.md', 'apply_patch docs']);
    assert.strictEqual((await store.recall('登录鉴权失败')).length, 1);
    assert.deepStrictEqual((await store.recall('登录鉴权失败'))[0]?.steps, [
      'read_file src/auth.ts',
      'apply_patch fix auth',
    ]);
    assert.strictEqual((await store.recall('完全不相关')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('workflow memory：有界（淘汰最旧）且空步骤不写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-workflows-bound-'));
  try {
    const store = new WorkflowMemoryStore(dir, {
      maxEntries: 1,
      now,
      path: join(dir, 'workflows.jsonl'),
    });
    await store.remember('alpha task', ['step a']);
    await store.remember('beta task', ['step b']);
    assert.strictEqual((await store.recall('alpha')).length, 0);
    assert.strictEqual((await store.recall('beta')).length, 1);
    await store.remember('empty', []);
    assert.strictEqual((await store.recall('empty')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
