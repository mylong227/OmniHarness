/**
 * 原子写 `durable` 判据：内容落盘、无临时残留；普通模式仍可用。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomicFileWriter } from '../../src/util/concurrency/atomicFileWriter.ts';

test('① durable 原子写：内容正确且不残留 .tmp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-durable-'));
  try {
    const file = join(dir, 'a.txt');
    await AtomicFileWriter.write(file, 'durable-content', { durable: true });
    assert.strictEqual(await readFile(file, 'utf8'), 'durable-content');
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('② durable 覆盖写：旧内容被完整替换（不是追加）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-durable-'));
  try {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'old', 'utf8');
    await AtomicFileWriter.write(file, 'new', { durable: true });
    assert.strictEqual(await readFile(file, 'utf8'), 'new');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
