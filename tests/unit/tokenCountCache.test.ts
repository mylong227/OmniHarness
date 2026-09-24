import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenEstimator } from '../../src/context/tokenEstimator.js';
import { TokenCountCache } from '../../src/context/tokenCountCache.js';

/** 一批覆盖中英混排、emoji、空串与长文本的样本。 */
function samples(): string[] {
  return [
    '',
    'hello',
    'a'.repeat(1000),
    '玄甲',
    '上下文压缩'.repeat(50),
    'hello 你好 mixed 内容 🙂🙂',
    'x'.repeat(4096) + '中文'.repeat(300),
  ];
}

/** 造一条超过缓存门槛（512 码元）的文本。 */
function longText(tag: string): string {
  return `${tag}:` + '内容与英文 mixed payload '.repeat(40);
}

test('Token 估算：开/关计数缓存的结果逐字相同（缓存不改变口径）', () => {
  const cached = new TokenEstimator(512);
  const uncached = new TokenEstimator(0);
  for (const text of samples()) {
    const expected = uncached.estimate(text);
    assert.strictEqual(cached.estimate(text), expected, `文本长度 ${text.length} 的结果应一致`);
  }
});

test('Token 估算：同一长文本第二次命中缓存，且计数不变（审计 §2.4 回归）', () => {
  const estimator = new TokenEstimator(8);
  const text = 'x'.repeat(4096) + '中文'.repeat(300);

  const first = estimator.estimate(text);
  const afterFirst = estimator.cacheStats();
  assert.strictEqual(afterFirst.misses, 1);
  assert.strictEqual(afterFirst.hits, 0);

  const second = estimator.estimate(text);
  const afterSecond = estimator.cacheStats();
  assert.strictEqual(second, first);
  assert.strictEqual(afterSecond.hits, 1, '重复文本必须命中缓存（否则每步仍在重扫全文）');
  assert.strictEqual(afterSecond.misses, 1);
});

test('Token 估算：短于门槛的文本**不进缓存**（实测避免小文本上查表倒挂）', () => {
  const estimator = new TokenEstimator(512);
  const short = 'short 短文本';
  assert.ok(short.length < 512);
  estimator.estimate(short);
  estimator.estimate(short);
  const stats = estimator.cacheStats();
  assert.strictEqual(stats.size, 0, '短文本不得占用缓存条目');
  assert.strictEqual(stats.hits + stats.misses, 0, '短文本连查表都不做（直接计数）');
});

test('Token 估算：逐步增长的上下文里，每条长消息只计一次（前缀增量语义）', () => {
  const estimator = new TokenEstimator(256);
  const steps: string[][] = [];
  const all: string[] = [];
  for (let step = 0; step < 20; step += 1) {
    all.push(longText(`第 ${String(step)} 条`));
    steps.push([...all]);
  }
  // 每一步都像真实记账那样「遍历当前全部消息」
  for (const contents of steps) {
    estimator.estimateMessages(contents.map((content) => ({ content })));
  }
  const stats = estimator.cacheStats();
  assert.strictEqual(stats.misses, 20, '未命中次数应等于**不同的**文本数（每条只重算一次）');
  assert.ok(stats.hits > 100, `稳定前缀应大量命中，实际 hits=${String(stats.hits)}`);
});

test('Token 估算：缓存有界（LRU 上限生效，长会话不会单调增长）', () => {
  const estimator = new TokenEstimator(4);
  for (let i = 0; i < 50; i += 1) {
    estimator.estimate(longText(`消息-${String(i)}`));
  }
  assert.strictEqual(estimator.cacheStats().size, 4, '条目数必须被上限约束');
});

test('Token 估算：maxCachedTexts=0 时完全不走缓存（保留旧行为）', () => {
  const estimator = new TokenEstimator(0);
  const text = longText('same');
  estimator.estimate(text);
  estimator.estimate(text);
  const stats = estimator.cacheStats();
  assert.strictEqual(stats.hits, 0);
  assert.strictEqual(stats.misses, 2);
  assert.strictEqual(stats.size, 0);
});

test('Token 估算：注入原生估算器时 estimateMessages 仍走原生（缓存不介入）', () => {
  const estimator = new TokenEstimator(8);
  estimator.setNativeEstimator(() => 4242);
  assert.strictEqual(estimator.estimateMessages([{ content: 'hi' }]), 4242);
  assert.strictEqual(estimator.cacheStats().hits, 0);
});

test('TokenCountCache：命中会续命，最久未使用者先被逐出', () => {
  const cache = new TokenCountCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.strictEqual(cache.get('a'), 1); // a 续命 ⇒ b 变成最久未使用
  cache.set('c', 3);
  assert.strictEqual(cache.size(), 2);
  assert.ok(cache.has('a'), '刚访问过的 a 应保留');
  assert.strictEqual(cache.has('b'), false, '最久未使用的 b 应被逐出');
  assert.ok(cache.has('c'));

  // 覆盖写同一键不增加条目数
  cache.set('c', 30);
  assert.strictEqual(cache.size(), 2);
  assert.strictEqual(cache.get('c'), 30);
});

test('TokenCountCache：clear 清空条目与计数', () => {
  const cache = new TokenCountCache(4);
  cache.set('a', 1);
  assert.strictEqual(cache.get('a'), 1);
  cache.clear();
  const stats = cache.stats();
  assert.deepStrictEqual(stats, { hits: 0, misses: 0, size: 0 });
});
