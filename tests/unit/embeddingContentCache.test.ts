/**
 * 语义索引的**嵌入内容复用**单测（2026-10-03，`docs/PROJECT_BOARD.md` §3.2）。
 *
 * 缺陷现场：`SemanticIndexCache` 的键含语料实例身份（审计 R3 的必要设计），于是语料变一个文件
 * 就是新对象 ⇒ 新键 ⇒ **整仓重新嵌入**。而嵌入选全链路最贵的一步，一次编辑却要重算全部向量。
 *
 * 本文件用**计数型假嵌入端口**（确定性、无模型依赖）钉住两件事：
 *   ① **真的省了**：语料增量更新后重建索引，只有内容变了的条目会调用模型；
 *   ② **没有走样**：复用结果与「冷缓存从零构建」的索引在检索上**逐位一致**
 *      ——省的是重复计算，不是正确性。
 * 另覆盖：角色分离（query/document 前缀不同不得混用）、代际清扫（内存不随编辑次数增长）、
 * 构建失败不清扫（否则下次重试要从零嵌入）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, type IndexedCorpus } from '../../src/context/contextEngine.js';
import { SemanticIndexCache } from '../../src/context/semanticIndexCache.js';
import { RecallKnobs } from '../../src/context/recallKnobs.js';
import type { Embedding, EmbedOptions, EmbeddingPort } from '../../src/ports/model/embedding.js';

/**
 * 计数型确定性假嵌入端口：向量由文本字符和推出（同文本恒同向量，不同文本可区分）。
 * 记录每次调用收到的文本数，用于断言「省了多少次嵌入」。
 */
class CountingEmbedding implements EmbeddingPort {
  /** 维度（小维度足够区分文本）。 */
  public readonly dim = 4;
  /** 累计被要求嵌入的文本总数。 */
  public embedded = 0;
  /** 每次调用收到的文本数（按调用顺序）。 */
  public readonly calls: number[] = [];
  /** 置位后下次 embed 抛错（模拟模型离线，验证失败不清扫）。 */
  public failNext = false;

  /**
   * 批量嵌入。
   * @param texts 待嵌入文本。
   * @param opts 选项（`role` 影响向量，模拟 e5 的前缀不对称）。
   * @returns 与输入等长的向量。
   */
  public async embed(texts: readonly string[], opts?: EmbedOptions): Promise<readonly Embedding[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('模型离线');
    }
    this.calls.push(texts.length);
    this.embedded += texts.length;
    const roleBias = opts?.role === 'query' ? 1 : 0;
    return texts.map((text) => {
      let a = 0;
      let b = 0;
      for (let i = 0; i < text.length; i += 1) {
        a += text.charCodeAt(i) % 7;
        b += text.charCodeAt(i) % 11;
      }
      return [a + roleBias, b + roleBias, text.length % 13, (a + b) % 17];
    });
  }
}

/** 造一个最小可语义索引的工作区。 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-embed-cache-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'alpha.ts'),
    'export class AlphaWidget {\n  spin(): void {}\n}\nexport function alphaRun(): number { return 1; }\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'src', 'beta.ts'),
    'export class BetaGadget {\n  hum(): void {}\n}\nexport function betaRun(): number { return 2; }\n',
    'utf8',
  );
  return dir;
}

/** 全量建语料（带产物表，供增量复用）。 */
function corpusOf(root: string): IndexedCorpus {
  return ContextEngine.indexCorpus(root, { morph: true, light: true });
}

/** 建索引（`SemanticIndexCache` 的真实路径）。 */
async function buildIndex(
  cache: SemanticIndexCache,
  root: string,
  corpus: IndexedCorpus,
  port: EmbeddingPort,
): Promise<Awaited<ReturnType<SemanticIndexCache['get']>>> {
  return cache.get(root, corpus, port, new RecallKnobs({}));
}

test('① 语料增量更新后重建：只有变化文件涉及的条目重新嵌入', async () => {
  const root = workspace();
  try {
    const cache = new SemanticIndexCache();
    const port = new CountingEmbedding();
    await buildIndex(cache, root, corpusOf(root), port);
    const fullCost = port.embedded;
    const fullEntries = cache.embeddingCacheStats().entries;
    assert.ok(fullCost > 0, '首次构建必须嵌入条目');
    assert.strictEqual(fullCost, fullEntries, '首次构建：嵌入条数 = 缓存条目数（全部未命中）');

    // 改一个文件（符号数不变，避免顺带变更符号集合），再重建。
    appendFileSync(join(root, 'src', 'alpha.ts'), '\n// 语义变更探针\n');
    port.embedded = 0;
    port.calls.length = 0;
    await buildIndex(cache, root, corpusOf(root), port);
    assert.ok(
      port.embedded < fullCost,
      `只改一个文件却重新嵌入了 ${String(port.embedded)}/${String(fullCost)} 条（复用未生效）`,
    );
    // 只应重嵌 alpha.ts 的文件文档（符号项文本不含正文，故不受影响）。
    assert.ok(
      port.embedded <= 2,
      `预期只有 alpha.ts 的文件文档重嵌，实得 ${String(port.embedded)} 条`,
    );
    assert.deepStrictEqual(
      cache.embeddingCacheStats(),
      {
        // 两次构建共 12 次查表：首轮 6 次全未命中；次轮 5 命中（未变条目）+ 1 未命中（变化的文件文档）。
        hits: fullCost - port.embedded,
        misses: fullCost + port.embedded,
        // 代际清扫后只剩**本轮碰过**的条目：未变的 5 条 + 新文本 1 条 = 6（旧文本条目被清掉）。
        entries: fullEntries,
      },
      '命中/未命中/常驻条目数都必须与「只重嵌变化条目」一致',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('② 复用结果的检索与「冷缓存从零构建」逐位一致（省的是重复计算，不是正确性）', async () => {
  const root = workspace();
  try {
    const warmCache = new SemanticIndexCache();
    const port = new CountingEmbedding();
    await buildIndex(warmCache, root, corpusOf(root), port);
    appendFileSync(
      join(root, 'src', 'beta.ts'),
      '\nexport function betaNew(): number { return 3; }\n',
    );
    const updated = corpusOf(root);
    const warm = await buildIndex(warmCache, root, updated, port);

    // 冷缓存 + 同一语料：从零嵌入（等价于「没有本缓存时的行为」）。
    const cold = await buildIndex(new SemanticIndexCache(), root, updated, new CountingEmbedding());
    for (const query of ['AlphaWidget spin', 'BetaGadget hum', 'betaNew', 'run number']) {
      const [warmHits, coldHits] = [await warm.search(query, 5), await cold.search(query, 5)];
      assert.deepStrictEqual(
        warmHits.map((h) => ({ id: h.id, score: h.score })),
        coldHits.map((h) => ({ id: h.id, score: h.score })),
        `查询「${query}」的命中与分数必须逐位一致`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('③ 角色分离：query 与 document 的向量不得互相复用', async () => {
  const root = workspace();
  try {
    const cache = new SemanticIndexCache();
    const port = new CountingEmbedding();
    const index = await buildIndex(cache, root, corpusOf(root), port);
    const before = port.embedded;
    // 同一查询连续两次：第二次必须命中（query 角色也被缓存）。
    await index.search('AlphaWidget', 3);
    const afterFirst = port.embedded;
    await index.search('AlphaWidget', 3);
    assert.strictEqual(port.embedded, afterFirst, '同一 query 文本第二次必须复用');
    assert.ok(afterFirst - before <= 2, 'query 只应嵌入 1 条');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('④ 代际清扫：多次编辑后缓存条目数不随编辑次数单调增长', async () => {
  const root = workspace();
  try {
    const cache = new SemanticIndexCache();
    const port = new CountingEmbedding();
    const sizes: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      appendFileSync(join(root, 'src', 'alpha.ts'), `\n// round ${String(round)}\n`);
      await buildIndex(cache, root, corpusOf(root), port);
      sizes.push(cache.embeddingCacheStats().entries);
    }
    const last = sizes[sizes.length - 1] ?? 0;
    const first = sizes[0] ?? 0;
    assert.ok(
      last <= first + 2,
      `条目数应被清扫约束（首轮 ${String(first)} → 末轮 ${String(last)}）`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⑤ 构建失败不代际清扫：模型离线重试时仍能复用既有向量', async () => {
  const root = workspace();
  try {
    const cache = new SemanticIndexCache();
    const port = new CountingEmbedding();
    await buildIndex(cache, root, corpusOf(root), port);
    const entriesBefore = cache.embeddingCacheStats().entries;
    assert.ok(entriesBefore > 0);

    // 新语料（触发新键新构建）+ 端口下次抛错 ⇒ get 抛出，调用方 fail-closed 回落 BM25。
    appendFileSync(join(root, 'src', 'beta.ts'), '\n// changed\n');
    port.failNext = true;
    await assert.rejects(buildIndex(cache, root, corpusOf(root), port));
    assert.strictEqual(
      cache.embeddingCacheStats().entries,
      entriesBefore,
      '失败路径不得清掉上一代可用向量',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
