import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiskCachedEmbeddingAdapter } from '../../src/adapters/embedding/diskCachedEmbeddingAdapter.js';
import type { Embedding, EmbeddingPort } from '../../src/ports/model/embedding.js';
import type { EmbedOptions } from '../../src/ports/model/embedding/embedOptions.js';

/** 确定性假嵌入端口：向量 = 文本长度铺满维度，并记录调用次数（用于断言「有没有回源」）。 */
class FakeEmbedding implements EmbeddingPort {
  /** 维度。 */
  public readonly dim: number;
  /** 模型身份（参与缓存键）。 */
  public readonly modelId: string;
  /** 回源调用次数。 */
  public calls = 0;

  /**
   * @param dim 维度。
   * @param modelId 模型身份。
   */
  public constructor(dim = 4, modelId = 'fake-model') {
    this.dim = dim;
    this.modelId = modelId;
  }

  /**
   * 把每条文本编码成「长度铺满维度」的确定性向量。
   * @param texts 文本列表。
   * @param _opts 选项（本假实现不使用，但参与缓存键的计算在被测类里）。
   * @returns 向量列表。
   */
  public async embed(
    texts: readonly string[],
    _opts?: EmbedOptions,
  ): Promise<readonly Embedding[]> {
    this.calls += 1;
    return texts.map((t) => new Array<number>(this.dim).fill(t.length));
  }
}

/** 造一个临时缓存目录。
 * @returns 目录绝对路径。
 */
const cacheDir = (): string => mkdtempSync(join(tmpdir(), 'omni-veccache-'));

test('DiskCachedEmbeddingAdapter: 跨实例（模拟进程重启）命中磁盘缓存，不再回源编码', async () => {
  const dir = cacheDir();
  try {
    const inner = new FakeEmbedding();
    const first = new DiskCachedEmbeddingAdapter({ inner, cacheDir: dir, cacheName: 'c1' });
    const out1 = await first.embed(['alpha', 'beta'], { role: 'document' });
    assert.deepEqual(out1, [
      [5, 5, 5, 5],
      [4, 4, 4, 4],
    ]);
    assert.strictEqual(inner.calls, 1);
    assert.strictEqual(first.flush(), true);

    // 新实例 + 新内层端口 = 进程重启：应当全部命中磁盘，内层一次都不被调用。
    const inner2 = new FakeEmbedding();
    const second = new DiskCachedEmbeddingAdapter({
      inner: inner2,
      cacheDir: dir,
      cacheName: 'c1',
    });
    const out2 = await second.embed(['alpha', 'beta'], { role: 'document' });
    assert.deepEqual(out2, out1);
    assert.strictEqual(inner2.calls, 0, '重启后应命中磁盘缓存，零回源');
    assert.deepEqual(second.stats(), {
      hits: 2,
      misses: 0,
      entries: 2,
      pending: 0,
      persistent: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCachedEmbeddingAdapter: 命中缓存时落盘口径是「只有新增才脏」，未新增不重复写盘', async () => {
  const dir = cacheDir();
  try {
    const inner = new FakeEmbedding();
    const adapter = new DiskCachedEmbeddingAdapter({
      inner,
      cacheDir: dir,
      cacheName: 'c1',
      flushThreshold: 1000,
    });
    await adapter.embed(['alpha'], { role: 'document' });
    assert.strictEqual(adapter.stats().pending, 1);
    // 第二次请求同一文本 ⇒ 全命中 ⇒ 不应产生新的脏条目，也不应写盘。
    assert.strictEqual(adapter.flush(), true);
    await adapter.embed(['alpha'], { role: 'document' });
    assert.strictEqual(adapter.stats().pending, 0);
    assert.strictEqual(adapter.flush(), false, '无脏条目时 flush 是空操作');
    assert.strictEqual(inner.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCachedEmbeddingAdapter: query 角色向量不产生落盘压力（查询文本每次都不同）', async () => {
  const dir = cacheDir();
  try {
    const inner = new FakeEmbedding();
    const adapter = new DiskCachedEmbeddingAdapter({
      inner,
      cacheDir: dir,
      cacheName: 'c1',
      flushThreshold: 1,
    });
    await adapter.embed(['a query'], { role: 'query' });
    assert.strictEqual(adapter.stats().pending, 0, 'query 不应计入脏条目');
    assert.strictEqual(adapter.flush(), false);
    assert.strictEqual(inner.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCachedEmbeddingAdapter: 换模型（modelId 变化）⇒ 整体不命中，绝不复用旧模型向量', async () => {
  const dir = cacheDir();
  try {
    const a = new DiskCachedEmbeddingAdapter({
      inner: new FakeEmbedding(4, 'model-a'),
      cacheDir: dir,
      cacheName: 'c1',
    });
    await a.embed(['alpha'], { role: 'document' });
    a.flush();

    // 同目录、同维度、不同模型：若键不含模型身份，这里会静默返回 model-a 的向量。
    const innerB = new FakeEmbedding(4, 'model-b');
    const b = new DiskCachedEmbeddingAdapter({ inner: innerB, cacheDir: dir, cacheName: 'c1' });
    await b.embed(['alpha'], { role: 'document' });
    assert.strictEqual(innerB.calls, 1, '换模型必须回源编码');
    assert.strictEqual(b.stats().hits, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCachedEmbeddingAdapter: 缓存文件被截断（行数与向量数不符）⇒ 只采用完整行，弃掉悬空键', async () => {
  const dir = cacheDir();
  try {
    // 手写一份「3 个键但只有 1 行向量」的损坏缓存（dim=2 ⇒ 每行 8 字节）。
    writeFileSync(join(dir, 'c1.keys'), 'k1\nk2\nk3\n', 'utf8');
    writeFileSync(join(dir, 'c1.f32'), Buffer.alloc(2 * 4));
    const inner = new FakeEmbedding(2, 'fake-model');
    const adapter = new DiskCachedEmbeddingAdapter({ inner, cacheDir: dir, cacheName: 'c1' });
    // 只应加载出 1 条（不能把 k2/k3 当成「有向量」而在命中时读出垃圾）。
    assert.strictEqual(adapter.stats().entries, 1);
    await adapter.embed(['x'], { role: 'document' });
    // 'x' 的键与 k1/k2/k3 都不同 ⇒ 必然回源，且不抛错。
    assert.strictEqual(inner.calls, 1);
    assert.strictEqual(adapter.stats().entries, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCachedEmbeddingAdapter: 不传 cacheDir ⇒ 纯内存缓存，不落盘且仍复用（诚实降级）', async () => {
  const dir = cacheDir();
  try {
    const inner = new FakeEmbedding();
    const adapter = new DiskCachedEmbeddingAdapter({ inner, cacheName: 'c1' });
    await adapter.embed(['alpha'], { role: 'document' });
    await adapter.embed(['alpha'], { role: 'document' });
    assert.strictEqual(inner.calls, 1, '同实例内仍应命中内存缓存');
    assert.strictEqual(adapter.stats().persistent, false);
    assert.strictEqual(adapter.flush(), false);
    assert.strictEqual(existsSync(join(dir, 'c1.keys')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCachedEmbeddingAdapter: 缓存目录不可写 ⇒ 不抛错、继续纯内存运行（缓存绝不变故障）', async () => {
  // 用一个「父路径是文件」的伪目录：mkdirSync 必然失败（ENOTDIR/EEXIST）。
  const dir = cacheDir();
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const inner = new FakeEmbedding();
    const adapter = new DiskCachedEmbeddingAdapter({
      inner,
      cacheDir: join(blocker, 'nested'),
      cacheName: 'c1',
    });
    const out = await adapter.embed(['alpha'], { role: 'document' });
    assert.deepEqual(out, [[5, 5, 5, 5]]);
    // flush 失败必须返回 false 而不是抛（否则一次磁盘问题会连累整个嵌入调用）。
    assert.strictEqual(adapter.flush(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DiskCachedEmbeddingAdapter: 空输入不触发任何编码，返回空数组', async () => {
  const inner = new FakeEmbedding();
  const adapter = new DiskCachedEmbeddingAdapter({ inner, cacheDir: undefined });
  assert.deepEqual(await adapter.embed([]), []);
  assert.strictEqual(inner.calls, 0);
});
