/**
 * (L5) 嵌入适配器「冷启动与预热」单测——**注入假 loader**，全程离线、不下载任何依赖或权重。
 *
 * 为什么需要这个接缝：验证 `preload()` 若走真实现，就必须先拿到 2.2GB 的可选依赖
 * `@huggingface/transformers` 与模型权重（本机不可行、离线不可验证），这正是 L5 长期
 * 「已登记·未落地」的原由。注入 loader 后，三条行为可在毫秒级内被钉死：
 *
 *   ① **不重建**：单实例复用 ⇒ N 次 embed 只构建 1 次 pipeline（Laya 那个「每次冷建 7.4s」
 *      的反面——本适配器本就不会重建，此处把它固化成断言，防将来改坏）；
 *   ② **预热可观测**：`preload()` 返回「是否真由本次构建 + 耗时」，让冷启动成本成为可读数字；
 *   ③ **失败可恢复**：首次构建失败后**必须**能重试成功——否则一个瞬时故障会把适配器永久瘫痪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TransformersEmbeddingAdapter,
  type TransformersModuleLoader,
  type TransformersModuleLike,
} from '../../src/adapters/embedding/transformersEmbeddingAdapter.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

/** 假 loader 的观测状态。 */
interface LoaderState {
  /** `loader()` 被调用次数（= 尝试加载模型包的次数）。 */
  calls: number;
  /** 剩余失败次数（用于模拟瞬时故障）。 */
  remainingFailures: number;
  /** 每次 `pipeline()` 被调用时看到的 `env.remoteHost`（用于验证镜像在构建前写入）。 */
  capturedRemoteHost: string[];
  /** `pipeline()` 被调用次数（= 真正构建管线的次数）。 */
  pipelineCalls: number;
}

/**
 * 造一个可控的假 loader + 其观测状态。
 * @param failTimes 前 N 次加载失败（模拟瞬时下载失败）。
 * @returns loader 与状态。
 */
function makeLoader(failTimes = 0): { loader: TransformersModuleLoader; state: LoaderState } {
  const state: LoaderState = {
    calls: 0,
    remainingFailures: failTimes,
    capturedRemoteHost: [],
    pipelineCalls: 0,
  };
  const loader: TransformersModuleLoader = async (): Promise<TransformersModuleLike> => {
    state.calls += 1;
    if (state.remainingFailures > 0) {
      state.remainingFailures -= 1;
      throw new Error('模拟模型包加载失败');
    }
    const module: TransformersModuleLike = {
      env: { remoteHost: 'https://default.invalid' },
      pipeline: async (): Promise<unknown> => {
        state.pipelineCalls += 1;
        state.capturedRemoteHost.push(module.env.remoteHost);
        // 假管线：返回带 tolist() 的对象，形状与 transformers.js 的张量输出一致。
        return async (): Promise<unknown> => ({ tolist: () => [[0.1, 0.2, 0.3]] });
      },
    };
    return module;
  };
  return { loader, state };
}

const makeAdapter = (loader: TransformersModuleLoader, remoteHost?: string) =>
  new TransformersEmbeddingAdapter({
    preset: 'minilm',
    loader,
    ...(remoteHost === undefined ? {} : { remoteHost }),
    localFilesOnly: true,
  });

test('L5 ① 不重建：N 次 embed 只构建一次 pipeline（单实例复用）', async () => {
  const { loader, state } = makeLoader();
  const adapter = makeAdapter(loader);
  await adapter.embed(['a'], { role: 'document' });
  await adapter.embed(['b'], { role: 'query' });
  await adapter.embed(['c'], { role: 'document' });
  assert.strictEqual(state.calls, 1, '模型包只应加载一次');
  assert.strictEqual(state.pipelineCalls, 1, 'pipeline 只应构建一次（不得每次重建）');
});

test('L5 ② 预热：首次 preload 真构建并报耗时，二次命中缓存报告未构建', async () => {
  const { loader, state } = makeLoader();
  const adapter = makeAdapter(loader);

  const first = await adapter.preload();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.built, true, '首次预热应真构建');
  assert.ok(first.ms >= 0, '应回报耗时');
  assert.strictEqual(state.pipelineCalls, 1);

  const second = await adapter.preload();
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.built, false, '已是热的 ⇒ 不应重复构建');
  assert.strictEqual(state.pipelineCalls, 1, '预热不得导致重复构建');
});

test('L5 ③ 失败可恢复：首次构建失败后能重试成功（不永久瘫痪）', async () => {
  const { loader, state } = makeLoader(1); // 第 1 次失败
  const adapter = makeAdapter(loader);

  const failed = await adapter.preload();
  assert.strictEqual(failed.ok, false, '首次应失败');
  assert.match(String(failed.error), /模拟模型包加载失败/);

  // 关键：失败必须清空缓存，否则此后每一步都复用那个已 reject 的 Promise ⇒ 永久瘫痪。
  const retried = await adapter.preload();
  assert.strictEqual(retried.ok, true, '失败后必须能重试成功');
  assert.strictEqual(retried.built, true);
  assert.strictEqual(state.calls, 2, '应重试了一次加载');
});

test('L5 ④ 镜像源在构建 pipeline **之前**写入（该库事后改无效）', async () => {
  const { loader, state } = makeLoader();
  // 按选项 JSDoc 约定传完整 URL（归一化只做 trim + 补尾斜杠，不补 scheme）。
  const adapter = makeAdapter(loader, 'https://hf-mirror.com');
  await adapter.preload();
  assert.deepEqual(
    state.capturedRemoteHost,
    ['https://hf-mirror.com/'],
    'pipeline 构建时应已看到归一化后的镜像源',
  );
});

test('L5 ④b 未设镜像源时沿用该库默认（零行为变更）', async () => {
  const { loader, state } = makeLoader();
  const adapter = makeAdapter(loader);
  await adapter.preload();
  assert.deepEqual(state.capturedRemoteHost, ['https://default.invalid'], '不得擅自改写默认源');
});

test('L5 ⑤ embed 经注入管线取回向量（形状透传）', async () => {
  const { loader } = makeLoader();
  const adapter = makeAdapter(loader);
  const vectors = await adapter.embed(['hello'], { role: 'query' });
  assert.deepEqual(vectors, [[0.1, 0.2, 0.3]]);
});

test('L5 ⑥ 预热开关：仅显式 `OMNI_EMBED_PRELOAD=1` 才开（默认关 ⇒ 零行为变更）', () => {
  assert.strictEqual(TransformersEmbeddingAdapter.shouldPreloadEmbedding({}), false);
  assert.strictEqual(
    TransformersEmbeddingAdapter.shouldPreloadEmbedding({ OMNI_EMBED_PRELOAD: '' }),
    false,
  );
  assert.strictEqual(
    TransformersEmbeddingAdapter.shouldPreloadEmbedding({ OMNI_EMBED_PRELOAD: '0' }),
    false,
  );
  assert.strictEqual(
    TransformersEmbeddingAdapter.shouldPreloadEmbedding({ OMNI_EMBED_PRELOAD: 'true' }),
    false,
  );
  assert.strictEqual(
    TransformersEmbeddingAdapter.shouldPreloadEmbedding({ OMNI_EMBED_PRELOAD: '1' }),
    true,
  );
});

/**
 * 用最小配置构建一次（只关心 `embedding` 字段）。
 * @returns 构建出的配置。
 */
const buildConfig = () =>
  ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 1,
    model: { name: 'stub', generate: async () => ({ text: 'ok' }) },
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: { name: 'capture', emit() {} },
    extraTools: [],
  });

test('L5 ⑦ 装配接线：语义路默认关 ⇒ 无嵌入端口（零开销、零行为变更）', () => {
  const saved = process.env.OMNI_SEMANTIC_RECALL;
  delete process.env.OMNI_SEMANTIC_RECALL;
  try {
    assert.strictEqual(buildConfig().embedding, undefined);
  } finally {
    if (saved !== undefined) process.env.OMNI_SEMANTIC_RECALL = saved;
  }
});

test('L5 ⑦b 装配接线：语义路开启 ⇒ 端口暴露 preload（实现可达，且构造不做 IO）', () => {
  const saved = process.env.OMNI_SEMANTIC_RECALL;
  // 刻意**不**设 OMNI_EMBED_PRELOAD：本用例只验证接线可达，不触发真预热（那会联网取权重）。
  process.env.OMNI_SEMANTIC_RECALL = '1';
  try {
    const embedding = buildConfig().embedding;
    assert.ok(embedding !== undefined, '语义路开启时应有嵌入端口');
    assert.strictEqual(typeof embedding.preload, 'function', '端口应暴露 preload（L5 接线点）');
    assert.ok(embedding instanceof TransformersEmbeddingAdapter, '实现应为 transformers 适配器');
  } finally {
    if (saved === undefined) delete process.env.OMNI_SEMANTIC_RECALL;
    else process.env.OMNI_SEMANTIC_RECALL = saved;
  }
});
