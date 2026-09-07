// #70 单测：native（Rust 内核 context.estimate）与 JS（TokenEstimator）token 估算逐位一致。
// 内核不可用时整体 skip（与 nativeBackend.test.ts 一致，避免 CI 无 .node 时红）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../src/native/nativeBackend.js';
import { TokenEstimator } from '../../src/context/tokenEstimator.js';

const messages = Array.from({ length: 40 }, (_unused, index) => ({
  content: `第 ${index} 条：混合 Mixed 文本 token estimate 测试，含中文与 English words. `.repeat(
    2,
  ),
}));

// 顶层探测一次，供原生依赖用例用 test({ skip }) 真跳过（旧写法 `if undefined return` 会虚增通过计数）。
const nativeEstimator = NativeBackend.tryCreate();
const nativeSkip =
  nativeEstimator === undefined ? '原生内核不可用（请先 npm run native:build）' : false;

test('native estimateTokens 与 JS estimateMessages 逐位一致', { skip: nativeSkip }, () => {
  const est = new TokenEstimator();
  const jsTokens = est.estimateMessages(messages);
  const nativeTokens = nativeEstimator!.estimateTokens(messages);
  assert.strictEqual(nativeTokens, jsTokens, 'native 与 JS token 估算应一致');
});

test('TokenEstimator.setNativeEstimator 接管 estimateMessages', () => {
  const est = new TokenEstimator();
  let delegated = false;
  est.setNativeEstimator((m) => {
    delegated = true;
    return m.length * 7 + 4; // 确定性假值，仅验证接管
  });
  const out = est.estimateMessages(messages);
  assert.strictEqual(delegated, true, '应调用原生估算器');
  assert.strictEqual(out, messages.length * 7 + 4, '应使用原生返回值');
});

test('未注入原生估算器时回退本地算法', () => {
  const est = new TokenEstimator();
  const out = est.estimateMessages(messages);
  // 本地算法：每条 content 估算 + 4；与手工公式一致
  const manual = messages.reduce((s, m) => {
    const cjk = (m.content.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
    const other = m.content.length - cjk;
    return s + Math.ceil(cjk + other / 4) + 4;
  }, 0);
  assert.strictEqual(out, manual, '未注入时应与本地算法一致');
});
