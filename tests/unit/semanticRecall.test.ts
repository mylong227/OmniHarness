import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SemanticIndex,
  rrfMerge,
  cosine,
  defaultEmbedBatchSize,
  resolveEmbedBatchSize,
} from '../../src/context/semanticRecall.js';
import type { Embedding, EmbeddingPort } from '../../src/ports/embedding.js';

/**
 * 确定性伪嵌入：把一组同义词映射到共享维度，使余弦相似度能表达「语义同义但字面不同」。
 * 仅用于单元测试，证明 SemanticIndex / rrfMerge 的算法在语义召回下成立（无需 80MB 真实模型）。
 */
class FakeEmbedding implements EmbeddingPort {
  public readonly dim = 8;
  // 同义词组 → 维度：授权类 / 清洗类 / 重试类
  private readonly groups: Record<string, number> = {
    authorization: 0,
    auth: 0,
    permission: 0,
    'access-control': 0,
    sanitize: 1,
    escape: 1,
    strip: 1,
    clean: 1,
    retry: 2,
    backoff: 2,
    redo: 2,
  };

  public async embed(texts: readonly string[]): Promise<readonly Embedding[]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const tok of t.toLowerCase().split(/[^a-z0-9]+/)) {
        const g = this.groups[tok];
        if (g !== undefined) v[g]! += 1;
      }
      // L2 归一化
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm) as Embedding;
    });
  }
}

test('cosine：相同向量=1，正交=0', () => {
  const a: Embedding = [1, 0, 0];
  const b: Embedding = [1, 0, 0];
  const c: Embedding = [0, 1, 0];
  assert.strictEqual(cosine(a, b), 1);
  assert.strictEqual(cosine(a, c), 0);
});

test('SemanticIndex：查询与代码字面不同但语义同义 → 向量召回命中（补 U3 鸿沟）', async () => {
  const port = new FakeEmbedding();
  const idx = new SemanticIndex(port);
  await idx.build([
    { id: 'a', text: 'permission gate evaluate' }, // 授权类
    { id: 'b', text: 'escape html user input' }, // 清洗类
    { id: 'c', text: 'fetch data url' }, // 无关
  ]);
  // 查询用 authorization（字面不与 permission 重叠），BM25 会漏；语义召回应命中 a
  const hits = await idx.search('authorization check', 3);
  assert.ok(hits.length > 0, '应有召回');
  assert.strictEqual(hits[0]?.id, 'a', '语义同义查询应命中 permissionGate(a)');
  assert.ok(hits[0]!.score > 0.5, `a 的余弦应较高，实际 ${hits[0]!.score}`);
});

test('SemanticIndex：字面完全重叠时也应命中（不劣于词法）', async () => {
  const port = new FakeEmbedding();
  const idx = new SemanticIndex(port);
  await idx.build([{ id: 'x', text: 'sanitize user input' }]);
  const hits = await idx.search('sanitize the input', 1);
  assert.strictEqual(hits[0]?.id, 'x');
});

test('rrfMerge：混合检索融合 BM25(词法) + 语义，互补提召回', () => {
  // BM25 因字面无重叠漏掉 a，但语义召回到 a；融合后 a 应进前列
  const bm25 = [{ id: 'b' }, { id: 'c' }];
  const semantic = [{ id: 'a' }, { id: 'b' }];
  const merged = rrfMerge([bm25, semantic]);
  assert.ok(merged.includes('a'), '融合结果应包含 BM25 漏掉的语义命中 a');
  assert.strictEqual(merged[0], 'b', '两路都命中的 b 应排最前');
});

test('rrfMerge：空输入返回空', () => {
  assert.deepStrictEqual(rrfMerge([]), []);
  assert.deepStrictEqual(rrfMerge([[]]), []);
});

// ── RRF 调参旋钮（U3 后续：真实代码库扫描证明 semWeight 是主杠杆） ──────────────

test('rrfMerge：weights 缺省 / 短于 lists 时回落等权 1', () => {
  const l1 = [{ id: 'a' }, { id: 'b' }];
  const l2 = [{ id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(
    rrfMerge([l1, l2], 60),
    rrfMerge([l1, l2], 60, [1, 1]),
    '不传 weights 应等价于各路等权 1',
  );
  assert.deepStrictEqual(
    rrfMerge([l1, l2], 60, [1]),
    rrfMerge([l1, l2], 60, [1, 1]),
    'weights 短于 lists 时缺失位应回落 1',
  );
});

test('rrfMerge：weights<1 抑制弱路噪声（仅语义命中的项下沉）', () => {
  // k=1 放大排名差异：w=1 时语义命中 a 与 BM25 次位 c 争第二，w=0.3 时 a 掉到 c 之后。
  const bm25 = [{ id: 'b' }, { id: 'c' }];
  const semanticOnly = [{ id: 'a' }];
  const equal = rrfMerge([bm25, semanticOnly], 1, [1, 1]);
  const damped = rrfMerge([bm25, semanticOnly], 1, [1, 0.3]);
  assert.ok(equal.indexOf('a') < equal.indexOf('c'), 'w=1 时语义命中 a 应压过 BM25 次位 c');
  assert.ok(
    damped.indexOf('a') > damped.indexOf('c'),
    'w=0.3 时 a 应下沉到 c 之后（语义噪声被抑制，BM25 信号不被稀释）',
  );
});

test('rrfMerge：k 越小排名越尖锐（头部命中权重更高，可翻转排序）', () => {
  // A 只在路 1 排第 1；B 在路 1 第 2、路 2 第 6（尾部）。
  const l1 = [{ id: 'A' }, { id: 'B' }];
  const l2 = [{ id: 'z0' }, { id: 'z1' }, { id: 'z2' }, { id: 'z3' }, { id: 'z4' }, { id: 'B' }];
  const sharp = rrfMerge([l1, l2], 1);
  const flat = rrfMerge([l1, l2], 60);
  assert.ok(sharp.indexOf('A') < sharp.indexOf('B'), 'k=1 时单路头部命中 A 应压过多路浅命中 B');
  assert.ok(flat.indexOf('B') < flat.indexOf('A'), 'k=60 时排名扁平化，B 反超 A');
});

test('defaultEmbedBatchSize：批大小随模型维度收缩（大模型不得沿用 minilm 的 256）', () => {
  // 回归事故：256 是 minilm(384) 的标定值；e5-large(1024) 沿用会冲到 ~11.8GB 常驻内存并挂死。
  assert.strictEqual(defaultEmbedBatchSize(384), 256, '384 维（minilm）保持历史标定值');
  assert.strictEqual(defaultEmbedBatchSize(768), 64, '768 维应收缩到 1/4');
  assert.strictEqual(defaultEmbedBatchSize(1024), 36, '1024 维（e5-large）应收缩到约 1/7');
  assert.ok(
    defaultEmbedBatchSize(1024) < defaultEmbedBatchSize(384),
    '维度越大批大小必须越小（内存 ∝ batch × seq × dim × layers）',
  );
  // 边界：极小维度（测试用伪嵌入 dim=4）被上限夹住，不得爆到天文数字
  assert.strictEqual(defaultEmbedBatchSize(4), 256, '极小维度由上界 256 夹住');
  assert.strictEqual(defaultEmbedBatchSize(0), 256, 'dim=0 不得产生除零/Infinity');
  assert.ok(defaultEmbedBatchSize(4096) >= 8, '超大维度仍有下界 8，不得退化为 0 批（死循环）');
});

test('resolveEmbedBatchSize：env OMNI_EMBED_BATCH 可覆盖，非法值回落推算值', () => {
  const prev = process.env.OMNI_EMBED_BATCH;
  try {
    process.env.OMNI_EMBED_BATCH = '16';
    assert.strictEqual(resolveEmbedBatchSize(1024), 16, '显式 env 优先');
    process.env.OMNI_EMBED_BATCH = 'abc';
    assert.strictEqual(
      resolveEmbedBatchSize(1024),
      defaultEmbedBatchSize(1024),
      '非法 env 回落推算值（不产出 NaN）',
    );
    process.env.OMNI_EMBED_BATCH = '0';
    assert.strictEqual(
      resolveEmbedBatchSize(1024),
      defaultEmbedBatchSize(1024),
      '0 非法，回落推算值',
    );
  } finally {
    if (prev === undefined) delete process.env.OMNI_EMBED_BATCH;
    else process.env.OMNI_EMBED_BATCH = prev;
  }
});

test('SemanticIndex：批大小按维度生效（1024 维时单批 ≤36 项，不整批喂给 onnxruntime）', async () => {
  /** 记录每次 embed 收到的最大批量。 */
  class RecordingEmbedding implements EmbeddingPort {
    public readonly dim: number;
    public maxBatch = 0;
    public calls = 0;
    public constructor(dim: number) {
      this.dim = dim;
    }
    public async embed(texts: readonly string[]): Promise<readonly Embedding[]> {
      this.calls++;
      this.maxBatch = Math.max(this.maxBatch, texts.length);
      return texts.map(() => [1, 0]);
    }
  }
  // 600 项：足以踩到 384 维的批上限 256，也能看出 1024 维被切得更碎。
  const items = Array.from({ length: 600 }, (_, i) => ({ id: `d${i}`, text: `doc ${i}` }));

  const small = new RecordingEmbedding(384);
  await new SemanticIndex(small).build(items);
  assert.strictEqual(small.maxBatch, 256, '384 维按 256 分批');
  assert.strictEqual(small.calls, 3, '600 项 / 256 = 3 批');

  const large = new RecordingEmbedding(1024);
  await new SemanticIndex(large).build(items);
  assert.ok(
    large.maxBatch <= 36,
    `1024 维单批必须 ≤36（实测 ${large.maxBatch}），否则大模型内存爆炸`,
  );
  assert.ok(large.calls > small.calls, '1024 维应被切成更多批');
});
