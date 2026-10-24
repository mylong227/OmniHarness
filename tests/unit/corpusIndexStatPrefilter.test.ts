import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusIndexCache } from '../../src/context/corpusIndexCache.ts';

/** 等一会（让 fs.watch 事件与 TTL 生效）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('CorpusIndexCache：watcher 可用时，TTL 到期的未变更语料只 stat 不再读内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omni-corpus-stat-'));
  const cache = new CorpusIndexCache({ maxEntries: 2, idleMs: 0, ttlMs: 10, watch: true });
  try {
    await writeFile(join(root, 'a.ts'), 'export const alpha = 1;\n', 'utf8');
    assert.notStrictEqual(cache.get(root), null);
    const before = cache.watch.stats();
    await sleep(25);
    assert.notStrictEqual(cache.get(root), null);
    const after = cache.watch.stats();
    if (cache.watch.isActive(root)) {
      assert.strictEqual(after.statReuses, before.statReuses + 1, '未变更应走 stat 快速复用');
      assert.strictEqual(after.fullHashes, before.fullHashes, '未变更不得再读全部文件');
    } else {
      // Linux 等不支持递归 fs.watch 的平台：必须回落内容哈希，而不是信 mtime。
      assert.strictEqual(after.fullHashes, before.fullHashes + 1);
    }
  } finally {
    cache.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('CorpusIndexCache：文件真的变了，stat 预筛后仍走内容哈希并更新语料', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omni-corpus-stat-change-'));
  const cache = new CorpusIndexCache({ maxEntries: 2, idleMs: 0, ttlMs: 10, watch: true });
  try {
    await writeFile(join(root, 'a.ts'), 'export const alpha = 1;\n', 'utf8');
    const first = cache.get(root);
    assert.notStrictEqual(first, null);
    await writeFile(join(root, 'a.ts'), 'export const beta = 2;\n', 'utf8');
    await sleep(30);
    const second = cache.get(root);
    assert.notStrictEqual(second, null);
    assert.match(second?.fileText.get('a.ts') ?? '', /beta/u, '内容变化必须被重新索引');
  } finally {
    cache.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
