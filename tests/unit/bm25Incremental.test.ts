/**
 * `Bm25Index` 就地替换（`setDocument`）的逐位对拍单测。
 *
 * 存在理由（2026-10-03）：repo-map 语料的增量重建依赖「就地替换槽位后，索引与全量重建
 * **逐位等价**」。BM25 打分含 `df` / 文档长度 / 平均长度三项统计，任何一项在替换时漏更新
 * 都会让分数**静默漂移**（召回变差但不报错），所以这里直接与全量重建对拍分数，而不是只看
 * 「命中集合大致相同」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bm25Index } from '../../src/search/bm25Index.js';

/** 造一份可复现的文档集（确定性，无随机源）。 */
function corpus(): string[][] {
  return [
    ['alpha', 'beta', 'gamma'],
    ['beta', 'beta', 'delta'],
    ['gamma', 'delta', 'epsilon', 'alpha'],
    ['zeta', 'alpha'],
    ['delta', 'epsilon'],
  ];
}

/**
 * 从文档集全量建索引。
 * @param docs 文档集。
 * @returns 索引。
 */
function build(docs: readonly (readonly string[])[]): Bm25Index {
  const index = new Bm25Index();
  index.addDocuments(docs);
  return index;
}

const QUERIES = ['alpha', 'beta', 'delta', 'epsilon', 'zeta', 'gamma'];

test('setDocument：就地替换若干槽位后与全量重建逐位一致（命中 id + 分数）', () => {
  const docs = corpus();
  const incremental = build(docs);
  const next = docs.map((d) => [...d]);
  next[1] = ['beta', 'omega', 'omega'];
  next[3] = ['alpha'];
  next[4] = ['epsilon', 'delta', 'zeta', 'omega'];
  for (const slot of [1, 3, 4]) {
    incremental.setDocument(slot, next[slot] ?? []);
  }
  const full = build(next);
  assert.strictEqual(incremental.documentCount, full.documentCount);
  assert.strictEqual(incremental.slotCount, full.slotCount);
  for (const q of QUERIES) {
    assert.deepStrictEqual(
      incremental.search([q], 5),
      full.search([q], 5),
      `查询「${q}」的命中与分数必须逐位一致`,
    );
  }
  for (const term of ['alpha', 'beta', 'delta', 'epsilon', 'zeta', 'gamma', 'omega']) {
    assert.strictEqual(
      incremental.documentFrequencyOf(term),
      full.documentFrequencyOf(term),
      `df(${term}) 必须一致`,
    );
    assert.strictEqual(incremental.idf(term), full.idf(term), `idf(${term}) 必须一致`);
  }
});

test('setDocument：槽位 == documentCount 时等价于追加', () => {
  const docs = corpus();
  const incremental = build(docs.slice(0, 3));
  incremental.setDocument(3, docs[3] ?? []);
  incremental.setDocument(4, docs[4] ?? []);
  const full = build(docs);
  assert.strictEqual(incremental.documentCount, 5);
  assert.deepStrictEqual(incremental.search(['alpha'], 5), full.search(['alpha'], 5));
});

test('setDocument：越界槽位 fail-closed 抛错（不静默错位）', () => {
  const index = build(corpus());
  assert.throws(() => index.setDocument(6, ['x']), /槽位越界/);
  assert.throws(() => index.setDocument(-1, ['x']), /槽位越界/);
  assert.throws(() => index.setDocument(1.5, ['x']), /槽位越界/);
  assert.strictEqual(index.documentCount, 5, '抛错路径不得改动索引');
});

test('setDocument：替换为空文档后再替换回来，统计完全复原（df/tf 无残留）', () => {
  const docs = corpus();
  const index = build(docs);
  index.setDocument(2, []);
  index.setDocument(2, docs[2] ?? []);
  const full = build(docs);
  for (const q of QUERIES) {
    assert.deepStrictEqual(index.search([q], 5), full.search([q], 5));
  }
});
