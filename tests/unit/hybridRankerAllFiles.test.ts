/**
 * 混合检索两处接线的组件级单测：
 *
 * 1. **`HybridRanker.rank` 暴露未截断的完整文件排名 `allFiles`**（第二段精排的候选池来源）。
 *    为什么必须有它：重排只能在**入池候选**里换位——池子若在融合后就截到 fileK，重排可动的余地
 *    为 0，等于没接。实测口径差 9.1pp（候选池只取 BM25 文件路 top-20 时 66.7%，放成完整融合池 75.8%）。
 * 2. **引擎混合路径真的接了第二段精排**（`getHybridRepoMapContext` 的 `rerank` 旋钮是活旋钮）。
 *    这条走「设了它，行为真的变」判据：同输入下 `rerank:false` 与 `rerank:true` 产出必须不同。
 *
 * 真实语料上的增益证据见 `evals/semantic-bridge-ab.mjs`（75.8% → 81.8%，2 捞回 / 0 丢失）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextEngine, type IndexedCorpus } from '../../src/context/contextEngine.js';
import { HybridRanker } from '../../src/context/hybridRanker.js';
import { RecallKnobs } from '../../src/context/recallKnobs.js';
import { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
import type { Embedding, EmbeddingPort } from '../../src/ports/model/embedding.js';

/** 夹具：搭建临时语料（与 fileReranker.test.ts 同构）。 */
class Fixture {
  /**
   * 写一个临时工作区并索引。
   * @param files 文件名 → 内容。
   * @returns 临时目录与已索引语料。
   */
  public static build(files: Readonly<Record<string, string>>): {
    dir: string;
    corpus: IndexedCorpus;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'hybridrerank-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    return { dir, corpus: ContextEngine.indexCorpus(dir, { morph: true, light: true }) };
  }
}

/** 确定性伪嵌入：按首字母分桶，足以让语义路产出稳定的命中列表。 */
class BucketEmbedding implements EmbeddingPort {
  /** 维度。 */
  public readonly dim = 4;

  /**
   * 按首字母哈希到维度桶并 L2 归一化。
   * @param texts 待嵌入文本。
   * @returns 与输入等长的向量列表。
   */
  public async embed(texts: readonly string[]): Promise<readonly Embedding[]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const ch of t.toLowerCase()) {
        const k = ch.charCodeAt(0) % this.dim;
        v[k] = (v[k] ?? 0) + 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm) as Embedding;
    });
  }
}

const FILES: Record<string, string> = {
  'alpha.ts': 'export function alphaWidgetParser() {\n  return 1;\n}\n',
  'beta.ts': 'export function betaWidgetWriter() {\n  return 2;\n}\n',
  'gamma.ts': 'export function gammaWidgetReader() {\n  return 3;\n}\n',
  'delta.ts': 'export function deltaWidgetCounter() {\n  return 4;\n}\n',
  'epsilon.ts': 'export const epsilonWidgetFlag = true;\n',
  'zeta.ts': 'export const zetaWidgetKind = "x";\n',
};

test('HybridRanker.rank：allFiles 是未截断的完整融合排名，files 是其前 fileK 个', () => {
  const { dir, corpus } = Fixture.build(FILES);
  try {
    const knobs = new RecallKnobs({ fileK: 2, symK: 3 });
    const bm25FileIds = corpus.files.slice(0, 5).map((f) => `file:${f.rel}`);
    const bm25SymIds = corpus.symbols.slice(0, 5).map((_, i) => `sym:${i}`);
    const ranked = new HybridRanker().rank({
      root: dir,
      corpus,
      knobs,
      bm25SymIds,
      bm25FileIds,
      semanticHits: [],
    });
    assert.ok(
      ranked.allFiles.length > knobs.fileK,
      `allFiles 必须比 fileK 深（否则重排无余地）：allFiles=${ranked.allFiles.length} fileK=${knobs.fileK}`,
    );
    assert.deepStrictEqual(
      ranked.files,
      ranked.allFiles.slice(0, knobs.fileK),
      'bm25Floor=0 时 files 应恰为 allFiles 的前 fileK 个',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HybridRanker.rank：bm25Floor 只重排 files，不改动 allFiles（候选池口径稳定）', () => {
  const { dir, corpus } = Fixture.build(FILES);
  try {
    const bm25FileIds = corpus.files.slice(0, 5).map((f) => `file:${f.rel}`);
    const bm25SymIds = corpus.symbols.slice(0, 5).map((_, i) => `sym:${i}`);
    const base = new HybridRanker().rank({
      root: dir,
      corpus,
      knobs: new RecallKnobs({ fileK: 3, symK: 3 }),
      bm25SymIds,
      bm25FileIds,
      semanticHits: [],
    });
    const floored = new HybridRanker().rank({
      root: dir,
      corpus,
      knobs: new RecallKnobs({ fileK: 3, symK: 3, bm25Floor: 2 }),
      bm25SymIds,
      bm25FileIds,
      semanticHits: [],
    });
    assert.deepStrictEqual(floored.allFiles, base.allFiles, '保护位不该影响完整排名');
    assert.strictEqual(floored.files.length, base.files.length, '保护位不改变入选个数');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 第三例专用夹具：刻意让**第一段（词袋）与第二段（精排）分歧**，从而使「rerank 是否活旋钮」
 * 这一断言真正可被证伪。
 *
 * 构造：`bigMention.ts` 在函数体里**顺带提及** `zebrafish` 多次（词袋高分，但**不定义**它）；
 * `smallDefines.ts` **恰好定义一个**含 `zebrafish` 的符号名（符号名 IDF 覆盖率高）。于是
 * `rerank:false` 把 bigMention 排在前（词频高），`rerank:true` 把 smallDefines 翻到前
 * （覆盖项度量的是「查询词是否被该文件**定义**」而非「顺带写了多少」）—— 正是 FileReranker 的设计意图。
 *
 * 为什么不能沿用 `FILES`：那 6 个文件**都**含 "widget"，第一段与第二段同序，重排无从改变
 * top-K，断言「产出必须不同」会误报死旋钮（本文件首版即踩此坑 —— 夹具不具区分力时，测试既
 * 证明不了旋钮是活的，也证明不了是死的）。
 */
const RERANK_FILES: Record<string, string> = {
  'bigMention.ts':
    'export function unrelatedThing() {\n  const s = "zebrafish zebrafish zebrafish zebrafish";\n  return s;\n}\n',
  'smallDefines.ts': 'export function zebrafishLocator() {\n  return 1;\n}\n',
  'filler1.ts': 'export function fillerOne() {\n  return 1;\n}\n',
  'filler2.ts': 'export function fillerTwo() {\n  return 2;\n}\n',
  'filler3.ts': 'export function fillerThree() {\n  return 3;\n}\n',
  'filler4.ts': 'export function fillerFour() {\n  return 4;\n}\n',
};

/** 第三例查询：一个只在 `smallDefines.ts` 被**定义**、在 `bigMention.ts` 被**顺带提及**的词。 */
const RERANK_QUERY = 'zebrafish locator';

test('引擎混合路径：rerank 是活旋钮（设了它，产出真的变），且入选文件数不变', async () => {
  const { dir } = Fixture.build(RERANK_FILES);
  try {
    const engine = new RepoMapContextEngine();
    const embedding = new BucketEmbedding();
    const off = await engine.getHybridRepoMapContext(dir, RERANK_QUERY, embedding, {
      fileK: 2,
      symK: 4,
      rerank: false,
    });
    const on = await engine.getHybridRepoMapContext(dir, RERANK_QUERY, embedding, {
      fileK: 2,
      symK: 4,
      rerank: true,
    });
    assert.ok(off !== null && on !== null, '两条路径都应产出上下文');
    assert.notStrictEqual(off, on, 'rerank 必须真的改变产出（否则是死旋钮）');
    // 精排的方向性：定义稀有名的文件应被抬到顺带提及它的文件之前。
    const firstFile = (text: string): string =>
      (text.split('\n').find((l) => l.startsWith('📄 ')) ?? '').slice(2).trim();
    assert.strictEqual(firstFile(off), 'bigMention.ts', '第一段（词袋）应先排顺带提及者');
    assert.strictEqual(firstFile(on), 'smallDefines.ts', '精排应把「定义者」翻到首位');
    const countOf = (text: string): number =>
      text.split('\n').filter((l) => l.startsWith('📄 ')).length;
    assert.strictEqual(countOf(on), countOf(off), '重排不改变入选文件个数（只换顺序/换成员）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
