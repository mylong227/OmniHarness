/**
 * 文件重排器（FileReranker）组件级单测 —— 两阶段检索第 2 段（打磨第二批 P1）。
 *
 * 验证六件事：
 * 1. **提升**：第一段排在后面、但**声明符号名**覆盖查询内容词的文件被抬到前面（核心行为）。
 * 2. **IDF 加权**：同覆盖率下，覆盖**稀有词**的文件优先于覆盖**常见词**的文件。
 * 3. **头部地板**：`floor` 个第一段头部被钉在原位；缺省地板 = `round(fileK / 3)` 且不超过候选数。
 * 4. **确定性**：同输入两次调用结果逐字相同（排序稳定）。
 * 5. **边界**：空候选 / fileK ≤ 0 返回空；无内容词时退化为「第一段次序」。
 * 6. **不增不减**：重排只重排，不新增也不丢弃候选（fileK = 池大小时为同一集合的置换）。
 *
 * 真实语料上的有效性证据（否决器 + AB + CI + 留出折）见 `evals/rerank-ab.mjs` 与
 * `evals/rerank-ab.report.json`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexCorpus, query } from '../../src/context/contextEngine.js';
import type { IndexedCorpus } from '../../src/context/contextEngine.js';
import { FileReranker } from '../../src/context/fileReranker.js';
import { FileRerankIndex } from '../../src/context/fileRerankIndex.js';

/** 夹具：把「文件内容 → 临时语料」的搭建收口。 */
class Fixture {
  /**
   * 写一个临时工作区并索引它。
   * @param files 文件名 → 内容
   * @returns 临时目录（供 finally 清理）与已索引语料
   */
  public static build(files: Readonly<Record<string, string>>): {
    dir: string;
    corpus: IndexedCorpus;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'reranker-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    return { dir, corpus: indexCorpus(dir, { morph: true, light: true }) };
  }
}

/** 声明 `widgetFactory` 的文件（符号名可拆出 widget / factory）。 */
const WIDGET_TS = ['// widget', 'export function widgetFactory(): void {', '  return;', '}'].join(
  '\n',
);

/** 声明 `bigThing` 的文件（与查询词无交集）。 */
const BIG_TS = ['export function bigThing(): number {', '  return 1;', '}'].join('\n');

/** 第三个无关文件。 */
const NOISE_TS = ['export function noiseThing(): number {', '  return 2;', '}'].join('\n');

test('提升：声明符号名覆盖查询词的文件被抬到最前（第一段排最后也照样捞回）', () => {
  const { dir, corpus } = Fixture.build({
    'w.ts': WIDGET_TS,
    'big.ts': BIG_TS,
    'noise.ts': NOISE_TS,
  });
  try {
    const result = new FileReranker().rerank({
      corpus,
      query: 'alpha widget',
      candidates: ['big.ts', 'noise.ts', 'w.ts'],
      fileK: 3,
      floor: 0,
    });
    assert.strictEqual(result.files[0], 'w.ts', '符号名覆盖者应排第一');
    assert.strictEqual(result.pinned, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IDF 加权：覆盖稀有词者优先于覆盖常见词者', () => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= 8; i += 1) {
    // 8 个文件都含字面词 common ⇒ 其 IDF 很低。
    files[`c${i}.ts`] = `export const common = ${i};`;
  }
  // 只有这一个文件含字面词 rare ⇒ 其 IDF 很高；同时它声明同名符号。
  files['rare.ts'] = 'export function rare(): void {\n  return;\n}';
  const { dir, corpus } = Fixture.build(files);
  try {
    const index = new FileRerankIndex();
    assert.ok(
      index.idf(corpus, 'rare') > index.idf(corpus, 'common'),
      '前置条件：rare 的 IDF 必须高于 common',
    );
    const result = new FileReranker().rerank({
      corpus,
      query: 'common rare',
      candidates: ['c1.ts', 'rare.ts'],
      fileK: 2,
      floor: 0,
    });
    assert.strictEqual(result.files[0], 'rare.ts', '覆盖稀有词者应胜出');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('头部地板：显式 floor 把第一段前 N 个钉在原位', () => {
  const { dir, corpus } = Fixture.build({
    'w.ts': WIDGET_TS,
    'big.ts': BIG_TS,
    'noise.ts': NOISE_TS,
  });
  try {
    const result = new FileReranker().rerank({
      corpus,
      query: 'alpha widget',
      candidates: ['big.ts', 'noise.ts', 'w.ts'],
      fileK: 3,
      floor: 2,
    });
    assert.strictEqual(result.pinned, 2);
    assert.deepEqual(
      [...result.files],
      ['big.ts', 'noise.ts', 'w.ts'],
      '前 2 个被钉住，w.ts 仍补在末尾',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('缺省地板 = 0（不设地板），显式值夹取到 [0, fileK]', () => {
  const { dir, corpus } = Fixture.build({
    'w.ts': WIDGET_TS,
    'big.ts': BIG_TS,
    'noise.ts': NOISE_TS,
  });
  try {
    const reranker = new FileReranker();
    const candidates = ['big.ts', 'noise.ts', 'w.ts'];
    // 缺省 0：实测本语料上地板近乎无操作，故不引入需额外解释的常量（见模块头「头部地板」节）。
    assert.strictEqual(
      reranker.rerank({ corpus, query: 'alpha widget', candidates, fileK: 14 }).pinned,
      0,
    );
    assert.strictEqual(
      reranker.rerank({ corpus, query: 'alpha widget', candidates, fileK: 3 }).pinned,
      0,
    );
    // 显式值夹取：负数 → 0，超过候选数 → 候选数。
    assert.strictEqual(
      reranker.rerank({ corpus, query: 'alpha widget', candidates, fileK: 3, floor: -2 }).pinned,
      0,
    );
    assert.strictEqual(
      reranker.rerank({ corpus, query: 'alpha widget', candidates, fileK: 3, floor: 9 }).pinned,
      3,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('确定性：同输入两次调用结果逐字相同', () => {
  const { dir, corpus } = Fixture.build({
    'w.ts': WIDGET_TS,
    'big.ts': BIG_TS,
    'noise.ts': NOISE_TS,
  });
  try {
    const reranker = new FileReranker();
    const args = {
      corpus,
      query: 'alpha widget',
      candidates: ['big.ts', 'noise.ts', 'w.ts'],
      fileK: 3,
    };
    assert.deepEqual([...reranker.rerank(args).files], [...reranker.rerank(args).files]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界：空候选 / fileK ≤ 0 返回空；无内容词时退化为第一段次序', () => {
  const { dir, corpus } = Fixture.build({ 'w.ts': WIDGET_TS, 'big.ts': BIG_TS });
  try {
    const reranker = new FileReranker();
    assert.deepEqual(
      [...reranker.rerank({ corpus, query: 'x', candidates: [], fileK: 5 }).files],
      [],
    );
    assert.deepEqual(
      [...reranker.rerank({ corpus, query: 'x', candidates: ['w.ts'], fileK: 0 }).files],
      [],
    );
    // 查询全为停用词 ⇒ 无内容词 ⇒ 覆盖率恒 0 ⇒ 分数只剩倒数秩 ⇒ 保持第一段次序。
    const kept = reranker.rerank({
      corpus,
      query: 'the and is',
      candidates: ['big.ts', 'w.ts'],
      fileK: 2,
      floor: 0,
    });
    assert.deepEqual([...kept.files], ['big.ts', 'w.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：query 的 rerank 只重排不增删，且 rerankFloor 端到端生效', () => {
  const files: Record<string, string> = {
    'w.ts': WIDGET_TS,
    'big.ts': BIG_TS,
    'noise.ts': NOISE_TS,
  };
  files['alpha.ts'] = 'export function alphaHelper(): void {\n  return;\n}';
  const { dir, corpus } = Fixture.build(files);
  try {
    const pool = [...query(corpus, 'alpha widget', { fileK: 999, rerank: false }).files];
    assert.ok(pool.length >= 2, `前置条件：池内应有多个候选，实际 ${pool.length}`);
    const reranked = [...query(corpus, 'alpha widget', { fileK: pool.length, rerank: true }).files];
    assert.strictEqual(reranked.length, pool.length, '重排不得丢弃候选');
    assert.deepEqual([...reranked].sort(), [...pool].sort(), '重排不得新增候选');
    // 地板 = 池大小 ⇒ 全部钉住 ⇒ 与第一段次序逐字相同（证明 rerankFloor 真的传到了重排器）。
    const allPinned = [
      ...query(corpus, 'alpha widget', {
        fileK: pool.length,
        rerank: true,
        rerankFloor: pool.length,
      }).files,
    ];
    assert.deepEqual(allPinned, pool, 'rerankFloor=池大小 应逐字复现第一段次序');
    // 地板 = 0 ⇒ 重排自由发挥，但仍只是同一集合的置换。
    const free = [
      ...query(corpus, 'alpha widget', { fileK: pool.length, rerank: true, rerankFloor: 0 }).files,
    ];
    assert.deepEqual([...free].sort(), [...pool].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
