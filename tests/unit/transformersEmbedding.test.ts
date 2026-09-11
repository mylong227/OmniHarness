import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_PRESETS,
  listModelPresets,
  withPrefix,
  TransformersEmbeddingAdapter,
} from '../../src/adapters/embedding/transformersEmbeddingAdapter.js';

test('预设表含 minilm、三个 e5 变体与 gte-large，且 e5 带前缀模式', () => {
  const presets = listModelPresets();
  assert.deepStrictEqual([...presets].sort(), [
    'e5-base-v2',
    'e5-large-v2',
    'e5-small-v2',
    'gte-large',
    'jina-base-code',
    'minilm',
  ]);
  assert.strictEqual(MODEL_PRESETS.minilm.prefix, undefined);
  assert.strictEqual(MODEL_PRESETS['e5-base-v2'].prefix, 'e5');
  assert.strictEqual(MODEL_PRESETS['e5-base-v2'].dim, 768);
  assert.strictEqual(MODEL_PRESETS['e5-small-v2'].dim, 384);
  assert.strictEqual(MODEL_PRESETS['e5-large-v2'].dim, 1024);
  assert.strictEqual(MODEL_PRESETS['gte-large'].prefix, undefined);
  assert.strictEqual(MODEL_PRESETS['gte-large'].dim, 1024);
});

test('构造器按 preset 解析 id / dim / 前缀模式（不触发模型下载）', () => {
  const a = new TransformersEmbeddingAdapter({ preset: 'minilm' });
  assert.strictEqual(a.modelId, 'Xenova/all-MiniLM-L6-v2');
  assert.strictEqual(a.dim, 384);

  const b = new TransformersEmbeddingAdapter({ preset: 'e5-base-v2' });
  assert.strictEqual(b.modelId, 'Xenova/e5-base-v2');
  assert.strictEqual(b.dim, 768);

  const d = new TransformersEmbeddingAdapter({ preset: 'gte-large' });
  assert.strictEqual(d.modelId, 'Xenova/gte-large');
  assert.strictEqual(d.dim, 1024);

  // 默认 = minilm
  const c = new TransformersEmbeddingAdapter();
  assert.strictEqual(c.modelId, 'Xenova/all-MiniLM-L6-v2');
  assert.strictEqual(c.dim, 384);
});

test('model 覆盖 preset，且自定义 id 无法预知前缀（默认 none）', () => {
  const a = new TransformersEmbeddingAdapter({ model: 'Xenova/foo-bar', dim: 512 });
  assert.strictEqual(a.modelId, 'Xenova/foo-bar');
  assert.strictEqual(a.dim, 512);
});

test('未知 preset 抛错并给出可选列表', () => {
  assert.throws(
    () => new TransformersEmbeddingAdapter({ preset: 'unixcoder' as never }),
    /未知嵌入预设/,
  );
});

test('withPrefix：none 模式原样返回，e5 按角色注入 query:/passage: 前缀', () => {
  const docs = ['hello world', 'foo bar'];
  // none
  assert.deepStrictEqual(withPrefix(docs, 'none', 'document'), docs);
  assert.deepStrictEqual(withPrefix(docs, 'none', 'query'), docs);
  // e5 document → passage:
  assert.deepStrictEqual(withPrefix(docs, 'e5', 'document'), [
    'passage: hello world',
    'passage: foo bar',
  ]);
  // e5 query → query:
  assert.deepStrictEqual(withPrefix(docs, 'e5', 'query'), ['query: hello world', 'query: foo bar']);
});
