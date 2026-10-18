import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailureReflectionStore } from '../../src/adapters/memory/failureReflectionStore.ts';

/** 固定时钟，保证 at 可断言。 */
const now = (): Date => new Date('2026-10-18T00:00:00.000Z');

test('失败反思：同目标召回、去重、有界', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-reflection-'));
  try {
    const store = new FailureReflectionStore(dir, {
      maxEntries: 2,
      now,
      path: join(dir, 'reflections.jsonl'),
    });
    await store.remember({
      toolName: 'write_file',
      targets: ['a.ts'],
      command: 'npm test',
      exitCode: 1,
      digest: 'AssertionError: a',
    });
    await store.remember({
      toolName: 'write_file',
      targets: ['a.ts'],
      command: 'npm test',
      exitCode: 1,
      digest: 'AssertionError: a',
    });
    await store.remember({
      toolName: 'edit',
      targets: ['b.ts'],
      command: 'npm test',
      exitCode: 1,
      digest: 'AssertionError: b',
    });
    await store.remember({
      toolName: 'write_file',
      targets: ['a.ts'],
      command: 'npm test',
      exitCode: 2,
      digest: 'AssertionError: c',
    });
    const lines = readFileSync(join(dir, 'reflections.jsonl'), 'utf8').trim().split(/\r?\n/u);
    assert.strictEqual(lines.length, 2, 'maxEntries=2 必须淘汰最旧');
    const recalled = await store.recall({ targets: ['a.ts'], limit: 5 });
    assert.strictEqual(recalled.length, 1, '只召回与 a.ts 重叠的条目');
    assert.strictEqual(recalled[0]?.toolName, 'write_file');
    assert.strictEqual(recalled[0]?.exitCode, 2);
    assert.deepStrictEqual(await store.recall({ targets: ['c.ts'] }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('失败反思：坏行跳过，文件不存在返回空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-reflection-bad-'));
  try {
    const store = new FailureReflectionStore(dir, { path: join(dir, 'x.jsonl') });
    assert.deepStrictEqual(await store.recall({ targets: ['a.ts'] }), []);
    await store.remember({
      toolName: 'write_file',
      targets: ['a.ts'],
      command: 'npm test',
      exitCode: 1,
      digest: 'x',
    });
    const before = readFileSync(join(dir, 'x.jsonl'), 'utf8');
    writeFileSync(join(dir, 'x.jsonl'), `${before}not-json\n`, 'utf8');
    assert.strictEqual((await store.recall({ targets: ['a.ts'] })).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
