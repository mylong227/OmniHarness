import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenEstimator } from '../../src/context/tokenEstimator.js';

test('Token 估算：空文本为 0', () => {
  assert.strictEqual(new TokenEstimator().estimate(''), 0);
});

test('Token 估算：英文按 4 字符/token 近似', () => {
  const estimator = new TokenEstimator();
  assert.strictEqual(estimator.estimate('hello'), 2);
  assert.strictEqual(estimator.estimate('a'.repeat(100)), 25);
});

test('Token 估算：中文按字数计', () => {
  const estimator = new TokenEstimator();
  assert.strictEqual(estimator.estimate('玄甲'), 2);
  assert.strictEqual(estimator.estimate('上下文压缩'), 5);
});

test('Token 估算：中英混排', () => {
  const estimator = new TokenEstimator();
  // 'hello ' 6 个非中文字 → 1.5 token；'你好' 2 字 → 2 token，合计 ceil(3.5)=4
  assert.strictEqual(estimator.estimate('hello 你好'), 4);
});

test('Token 估算：消息列表含角色开销', () => {
  const estimator = new TokenEstimator();
  const messages = [{ content: 'hi' }, { content: 'hi' }];
  // 每条: estimate('hi')=1 + 角色开销 4 = 5；两条共 10
  assert.strictEqual(estimator.estimateMessages(messages), 10);
});

test('Token 估算：空消息列表为 0', () => {
  assert.strictEqual(new TokenEstimator().estimateMessages([]), 0);
});
