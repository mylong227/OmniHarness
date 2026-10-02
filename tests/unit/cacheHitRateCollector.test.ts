import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheHitRateCollector } from '../../src/observability/cacheHitRateCollector.js';
import { CorpusIndexCache } from '../../src/context/corpusIndexCache.js';
import { RepoMapMemo } from '../../src/context/repoMap/repoMapMemo.js';

test('CacheHitRateCollector: 无样本时命中率记 0 且 samples 为 0（区分「没被调用」与「命中率 0」）', () => {
  const c = new CacheHitRateCollector();
  const snap = c.snapshot();
  assert.deepEqual(snap, {});

  c.record('X', false);
  const one = c.snapshot();
  assert.strictEqual(one['X']?.hits, 0);
  assert.strictEqual(one['X']?.misses, 1);
  assert.strictEqual(one['X']?.samples, 1);
  assert.strictEqual(one['X']?.hitRate, 0);
});

test('CacheHitRateCollector: 命中率按名独立累加，reset 清空', () => {
  const c = new CacheHitRateCollector();
  c.record('A', true);
  c.record('A', true);
  c.record('A', false);
  c.record('B', false);

  const snap = c.snapshot();
  assert.strictEqual(snap['A']?.hits, 2);
  assert.strictEqual(snap['A']?.misses, 1);
  assert.strictEqual(snap['A']?.samples, 3);
  assert.ok(Math.abs((snap['A']?.hitRate ?? 0) - 2 / 3) < 1e-9);
  assert.strictEqual(snap['B']?.hitRate, 0);
  assert.deepEqual(Object.keys(snap), ['A', 'B']);

  c.reset();
  assert.deepEqual(c.snapshot(), {});
});

test('CorpusIndexCache: 未接 onSample 时统计不影响行为，stats 仍如实累加', () => {
  const cache = new CorpusIndexCache({ maxEntries: 1 });
  // 指向一个必然索引失败的根（不存在）：fail-closed 返回 null，且**不计入**命中率样本。
  const bad = cache.get('D:/__definitely_not_a_real_root__/xyz');
  assert.strictEqual(bad, null);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, entries: 0 });
});

test('CorpusIndexCache: onSample 收到与 stats 同源的判定', () => {
  const seen: boolean[] = [];
  const cache = new CorpusIndexCache({ maxEntries: 1, onSample: (hit) => seen.push(hit) });
  cache.get('D:/__definitely_not_a_real_root__/xyz');
  // 索引失败 ⇒ 既不计 miss 也不上报（它不是缓存语义）。
  assert.deepEqual(seen, []);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, entries: 0 });
});

test('RepoMapMemo: 命中/未命中同时累加自身计数并上报 onSample', () => {
  const seen: boolean[] = [];
  const memo = new RepoMapMemo((hit) => seen.push(hit));
  const corpusA = { tag: 'a' };
  const corpusB = { tag: 'b' };

  assert.strictEqual(memo.lookup('k1', corpusA).hit, false);
  memo.store('k1', corpusA, 'text-1');
  assert.strictEqual(memo.lookup('k1', corpusA).hit, true);
  // 语料实例变了（重新索引）⇒ 即使键相同也必须 miss。
  assert.strictEqual(memo.lookup('k1', corpusB).hit, false);

  assert.deepEqual(seen, [false, true, false]);
  assert.strictEqual(memo.stats().hits, 1);
  assert.strictEqual(memo.stats().misses, 2);
});
