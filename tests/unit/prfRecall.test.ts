import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexCorpus, query, type IndexedCorpus } from '../../src/context/contextEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', '..', 'src');

let CORPUS: IndexedCorpus | undefined;
function corpus(): IndexedCorpus {
  if (CORPUS === undefined) CORPUS = indexCorpus(SRC, { morph: true, light: true });
  return CORPUS;
}

// 若干查询：覆盖「原词法直接命中」与「需扩展才命中」两类，确保 PRF 路径真实生效。
const QUERIES = [
  'where is tool registration handled',
  'how does sandbox denial escalate to approval',
  'how is the resonant memory probe mapped from text',
  'which component gates dangerous tool calls at runtime',
];

test('PRF 默认关 = 显式 prf:false（零行为变更）', () => {
  const c = corpus();
  for (const q of QUERIES) {
    const def = query(c, q, { fileK: 10 }).files;
    const off = query(c, q, { fileK: 10, prf: false }).files;
    assert.deepEqual(def, off, `query 默认应等同 prf:false（${q}）`);
  }
});

test('PRF 开启（prf:true）真正改变检索排序（扩展+重排生效，非静默无操作）', () => {
  const c = corpus();
  let changed = 0;
  for (const q of QUERIES) {
    const off = query(c, q, { fileK: 10, prf: false }).files;
    const on = query(c, q, { fileK: 10, prf: true }).files;
    assert.ok(on.length > 0, `prf:true 应返回非空结果（${q}）`);
    if (JSON.stringify(off) !== JSON.stringify(on)) changed += 1;
  }
  // 至少一个查询的排序被 PRF 改变（证明扩展查询重排真实生效，而非空跑）。
  assert.ok(changed >= 1, `PRF 应改变至少一条查询的排序（实际改变 ${changed}/${QUERIES.length}）`);
});

test('PRF 不破坏结果有效性（全部为语料内真实文件）', () => {
  const c = corpus();
  const valid = new Set(c.files.map((fr) => fr.rel));
  for (const q of QUERIES) {
    for (const f of query(c, q, { fileK: 10, prf: true }).files) {
      assert.ok(valid.has(f), `PRF 结果含未知文件：${f}`);
    }
  }
});
