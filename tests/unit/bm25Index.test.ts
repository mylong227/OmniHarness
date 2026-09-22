/**
 * Bm25Index 倒排表改造的**等价性回归**（2026-09-22 性能收尾）。
 *
 * 改造动机：`search` 原为「每个查询词 × 每篇文档 × 每个 token」的全量扫描
 * （实测真实语料 18.6 ms～252 ms/次），改为 postings 倒排表后 169×～985×。
 * 本测试用**暴力实现**（同一 BM25 公式、逐篇现算 tf）逐位对拍，钉住三件事：
 * ① 同一组查询的命中 id / 分数 / 次序完全一致；② 分批 `addDocuments` 后 docId 偏移正确；
 * ③ `documentFrequencyOf` / `idf` 口径未漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bm25Index } from '../../src/search/bm25Index.js';

/** 暴力参照实现：逐篇扫描算 tf（即改造前的算法），用作黄金标准。 */
function bruteForce(
  docs: readonly (readonly string[])[],
  query: readonly string[],
  limit: number,
  k1 = 1.5,
  b = 0.75,
): Array<{ id: number; score: number }> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const count = docs.length;
  let total = 0;
  for (const doc of docs) total += doc.length;
  const avg = count === 0 ? 0 : total / count;
  const scores = new Array<number>(count).fill(0);
  for (const term of query) {
    const freq = df.get(term);
    if (freq === undefined) continue;
    const idf = Math.log(1 + (count - freq + 0.5) / (freq + 0.5));
    if (idf <= 0) continue;
    for (let i = 0; i < count; i += 1) {
      const doc = docs[i] ?? [];
      let tf = 0;
      for (const token of doc) {
        if (token === term) tf += 1;
      }
      if (tf === 0) continue;
      const den = tf + k1 * (1 - b + b * (avg === 0 ? 0 : doc.length / avg));
      scores[i] = (scores[i] ?? 0) + (idf * (tf * (k1 + 1))) / den;
    }
  }
  const hits: Array<{ id: number; score: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const score = scores[i] ?? 0;
    if (score > 0) hits.push({ id: i, score });
  }
  hits.sort((left, right) => right.score - left.score);
  return hits.slice(0, limit);
}

/** 覆盖重复词、长短文档、无命中词、未收录词的语料。 */
const DOCS: string[][] = [
  ['tool', 'tool', 'registry', 'register'],
  ['sandbox', 'policy', 'tool'],
  ['tool'],
  ['context', 'assembler', 'context', 'context', 'assembler'],
  ['unrelated', 'words', 'only'],
  ['tool', 'sandbox', 'context', 'spill', 'spill', 'spill'],
];

const QUERIES: string[][] = [
  ['tool'],
  ['tool', 'sandbox'],
  ['context', 'assembler'],
  ['spill', 'spill'],
  ['registry', 'tool'],
  ['nonexistent'],
  ['tool', 'nonexistent', 'context'],
  [],
];

test('倒排表与暴力实现在全部查询上逐位一致（id + 分数 + 次序）', () => {
  const index = new Bm25Index();
  index.addDocuments(DOCS);
  for (const query of QUERIES) {
    const got = index.search(query, 10);
    const want = bruteForce(DOCS, query, 10);
    assert.deepStrictEqual(got, want, `查询 ${JSON.stringify(query)} 结果不一致`);
  }
});

test('分批 addDocuments 的 docId 偏移正确（postings 跨批累加）', () => {
  const batched = new Bm25Index();
  batched.addDocuments(DOCS.slice(0, 2));
  batched.addDocuments(DOCS.slice(2));
  const single = new Bm25Index();
  single.addDocuments(DOCS);
  assert.strictEqual(batched.documentCount, single.documentCount);
  for (const query of QUERIES) {
    assert.deepStrictEqual(batched.search(query, 10), single.search(query, 10));
  }
});

test('df / idf 口径与暴力统计一致（重排器等消费方依赖同源 IDF）', () => {
  const index = new Bm25Index();
  index.addDocuments(DOCS);
  const df = new Map<string, number>();
  for (const doc of DOCS) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  for (const [term, freq] of df) {
    assert.strictEqual(index.documentFrequencyOf(term), freq, `${term} 的 df 漂移`);
  }
  assert.strictEqual(index.documentFrequencyOf('nonexistent'), 0);
  assert.strictEqual(index.documentCount, DOCS.length);
});

test('边界：limit ≤ 0、空索引、词频重复时排序稳定', () => {
  const empty = new Bm25Index();
  assert.deepStrictEqual(empty.search(['tool'], 10), []);
  const index = new Bm25Index();
  index.addDocuments(DOCS);
  assert.deepStrictEqual(index.search(['tool'], 0), []);
  // 同分时按 docId 升序（稳定排序）——与改造前行为一致
  const hits = index.search(['tool'], 10);
  for (let i = 1; i < hits.length; i += 1) {
    const prev = hits[i - 1];
    const cur = hits[i];
    if (prev !== undefined && cur !== undefined && prev.score === cur.score) {
      assert.ok(prev.id < cur.id, '同分应按 docId 升序');
    }
  }
});

test('k1 / b 覆盖仍可用（同一索引零成本重打分）', () => {
  const index = new Bm25Index();
  index.addDocuments(DOCS);
  const base = index.search(['tool', 'sandbox'], 10);
  const tuned = index.search(['tool', 'sandbox'], 10, { k1: 0.8, b: 0.2 });
  assert.deepStrictEqual(tuned, bruteForce(DOCS, ['tool', 'sandbox'], 10, 0.8, 0.2));
  assert.notDeepStrictEqual(tuned, base, '不同 k1/b 应改变分数');
});
