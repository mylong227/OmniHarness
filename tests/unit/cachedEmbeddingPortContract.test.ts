/**
 * `CachedEmbeddingPort` 的**能力透传契约**判据（2026-10-11）。
 *
 * ## 为什么补这条（不是为凑覆盖率）
 *
 * 该装饰器在类文档里写明了三条**能力边界**，而此前仓内**没有直接判据**——它只被
 * `SemanticIndexCache` 间接用到，那部分覆盖是"顺手覆盖"：
 * 1. `preload` **仅在实现侧存在时透出**（"无条件暴露该方法会把『不支持预热』伪装成『支持』"）；
 * 2. `flush` 同理必须透传，否则 `SemanticIndexCache` 的"构建后落盘"会静默失效；
 * 3. 命中缓存时**不得调用内层**（否则缓存装饰器等于没有）。
 *
 * 触发补这条的直接原因（实测）：给 `headless.test.ts` 显式关闭语义检索后，本文件的覆盖率从
 * 97.5% 掉到 93.75%（缺 preload 透传那三行）——因为**测试 spawn 的 CLI 子进程覆盖也会并进报告**，
 * 那三行原本是 CLI 跑 agent 回合时"顺手"覆盖的。正确处置不是下调基线，而是把这条契约**显式判据化**。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CachedEmbeddingPort } from '../../src/context/cachedEmbeddingPort.ts';
import { EmbeddingContentCache } from '../../src/context/embeddingContentCache.ts';
import type { EmbeddingPort } from '../../src/ports/model/embedding/embeddingPort.ts';
import type { EmbeddingPreloadOutcome } from '../../src/ports/model/embedding/embeddingPreloadOutcome.ts';

/** 记录调用的假内层端口（可选能力按需给出）。 */
class FakeInner implements EmbeddingPort {
  /** `embed` 被调用次数（判据③要证明命中时不调用内层）。 */
  public embedCalls = 0;
  /** `preload` 被调用次数。 */
  public preloadCalls = 0;
  /** `flush` 被调用次数。 */
  public flushCalls = 0;

  /** 维度（与真实适配器同形；判据只要求与内层一致）。 */
  public readonly dim = 4;

  /**
   * 构造假内层（可选能力按需给出）。
   *
   * @param options 是否提供 `preload` / `flush`。
   */
  public constructor(options: { readonly preload: boolean; readonly flush: boolean }) {
    if (options.preload) {
      this.preload = (): Promise<EmbeddingPreloadOutcome> => {
        this.preloadCalls += 1;
        return Promise.resolve({ ok: true, ms: 7, built: true });
      };
    }
    if (options.flush) {
      this.flush = (): boolean => {
        this.flushCalls += 1;
        return true;
      };
    }
  }

  /** 可选预热（仅当构造时声明提供）。 */
  public preload?: () => Promise<EmbeddingPreloadOutcome>;

  /** 可选落盘（仅当构造时声明提供）。 */
  public flush?: () => boolean;

  /**
   * 批量嵌入（返回按输入长度生成的确定性向量）。
   *
   * @param texts 待嵌入文本。
   * @returns 与输入等长的向量数组。
   */
  public async embed(texts: readonly string[]): Promise<readonly number[][]> {
    this.embedCalls += 1;
    return texts.map((text) => [text.length, 1, 2, 3]);
  }
}

test('① preload 仅在实现侧存在时透出（不得把"不支持预热"伪装成"支持"）', async () => {
  const withPreload = new CachedEmbeddingPort(
    new FakeInner({ preload: true, flush: false }),
    new EmbeddingContentCache(),
  );
  const inner = new FakeInner({ preload: true, flush: false });
  const port = new CachedEmbeddingPort(inner, new EmbeddingContentCache());
  assert.strictEqual(typeof port.preload, 'function', '内层有 preload ⇒ 装饰器必须透出');
  const outcome = await port.preload?.();
  assert.deepStrictEqual(outcome, { ok: true, ms: 7, built: true }, '透传必须真的转到内层');
  assert.strictEqual(inner.preloadCalls, 1, '应恰好调用内层一次');

  const without = new CachedEmbeddingPort(
    new FakeInner({ preload: false, flush: false }),
    new EmbeddingContentCache(),
  );
  assert.strictEqual(
    without.preload,
    undefined,
    '内层没有 preload ⇒ 装饰器**不得**暴露该方法（否则装配层会以为支持预热）',
  );
  assert.ok(withPreload !== undefined);
});

test('② flush 必须透传（否则"构建后落盘"静默失效）', () => {
  const inner = new FakeInner({ preload: false, flush: true });
  const port = new CachedEmbeddingPort(inner, new EmbeddingContentCache());
  assert.strictEqual(typeof port.flush, 'function', '内层有 flush ⇒ 装饰器必须透出');
  assert.strictEqual(port.flush?.(), true, '应回传内层的落盘结果');
  assert.strictEqual(inner.flushCalls, 1);

  const without = new CachedEmbeddingPort(
    new FakeInner({ preload: false, flush: false }),
    new EmbeddingContentCache(),
  );
  assert.strictEqual(without.flush, undefined, '内层没有 flush ⇒ 不得暴露（调用点用 `?.` 兜住）');
});

test('③ 缓存命中不得调用内层；未命中才调用并把向量存入缓存', async () => {
  const inner = new FakeInner({ preload: false, flush: false });
  const cache = new EmbeddingContentCache();
  const port = new CachedEmbeddingPort(inner, cache);

  const first = await port.embed(['alpha', 'beta'], { role: 'document' });
  assert.strictEqual(inner.embedCalls, 1, '首次未命中必须调用内层');
  assert.strictEqual(first.length, 2);

  const second = await port.embed(['alpha', 'beta'], { role: 'document' });
  assert.strictEqual(
    inner.embedCalls,
    1,
    '同样的 (角色, 文本) 再嵌入 ⇒ 必须命中缓存、不得再调内层',
  );
  assert.deepStrictEqual(second, first, '命中缓存必须返回等值向量');

  // 正对照：换角色即换了缓存键 ⇒ 必须重新调用内层（证明③不是"因为压根没走缓存"）。
  await port.embed(['alpha'], { role: 'query' });
  assert.strictEqual(inner.embedCalls, 2, '角色参与缓存键 ⇒ 换角色应未命中');
  assert.strictEqual(port.dim, inner.dim, 'dim 必须与内层一致');
});
