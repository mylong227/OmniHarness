import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusIndexCache } from '../../src/context/corpusIndexCache.ts';

/** 建一个最小工作区（一个 TS 文件即可被索引）。 */
async function workspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omni-corpus-${name}-`));
  await writeFile(
    join(root, 'sample.ts'),
    `export function ${name}Fn(value: string): string { return value.trim(); }\n`,
    'utf8',
  );
  return root;
}

test('CorpusIndexCache：按估算字节预算淘汰，而不是只看条数', async () => {
  const a = await workspace('alpha');
  const b = await workspace('beta');
  const evicted: string[] = [];
  // 单份估算 > 1 B ⇒ 第二条写入必须先淘汰第一条（至少保留单条）。
  const cache = new CorpusIndexCache({
    maxEntries: 4,
    maxBytes: 1024,
    idleMs: 0,
    onEvict: (root) => evicted.push(root),
  });
  try {
    assert.notStrictEqual(cache.get(a), null);
    assert.notStrictEqual(cache.get(b), null);
    assert.strictEqual(cache.stats().entries, 1, '字节预算只应留下最近一份');
    assert.deepStrictEqual(evicted, [a], '淘汰顺序应为最久未访问的 a');
    assert.ok(cache.bytesInUse() > 0, '估算字节必须可观测');
  } finally {
    cache.dispose();
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test('CorpusIndexCache：空闲超过 idleMs 即释放，并在下次 get 前清理', async () => {
  const root = await workspace('idle');
  const cache = new CorpusIndexCache({ maxEntries: 2, idleMs: 1_000 });
  try {
    assert.notStrictEqual(cache.get(root), null);
    const now = Date.now();
    assert.strictEqual(cache.sweepIdle(now + 2_000), 1);
    assert.strictEqual(cache.stats().entries, 0);
  } finally {
    cache.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('CorpusIndexCache：maxEntries 收紧到 2 后不会保留第 3 个工作区', async () => {
  const roots = await Promise.all([workspace('one'), workspace('two'), workspace('three')]);
  const cache = new CorpusIndexCache({ maxEntries: 2, idleMs: 0 });
  try {
    for (const root of roots) assert.notStrictEqual(cache.get(root), null);
    assert.strictEqual(cache.stats().entries, 2);
  } finally {
    cache.dispose();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
