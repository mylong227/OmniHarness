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

test('Token 估算：工具调用参数计入消息记账（PROJECT_BOARD §3-3 回归判据）', () => {
  const estimator = new TokenEstimator();
  const call = {
    id: 'c1',
    name: 'write_file',
    arguments: { path: 'a.ts', content: 'x'.repeat(400) },
  };
  const bare = estimator.estimateMessages([{ content: 'hi' }]);
  const withCall = estimator.estimateMessages([{ content: 'hi', toolCalls: [call] }]);
  // 旧实现只计 content ⇒ withCall === bare，工具链会话的记账系统性偏低。
  assert.ok(withCall > bare, '带 tool_calls 的消息必须比裸消息记更多 token');
  // 记账文本 = content + NUL + 工具调用 JSON（唯一实现，见 accountableText）。
  assert.strictEqual(
    TokenEstimator.accountableText({ content: 'hi', toolCalls: [call] }),
    `hi\u0000${JSON.stringify([call])}`,
  );
});

test('Token 估算：思考回传 reasoningContent 计入消息记账', () => {
  const estimator = new TokenEstimator();
  const bare = estimator.estimateMessages([{ content: '答' }]);
  const withReasoning = estimator.estimateMessages([
    { content: '答', reasoningContent: '先想一步再回答：' },
  ]);
  assert.ok(withReasoning > bare, 'DeepSeek 思考模式要求回传 reasoning，占请求体故须入账');
});

test('Token 估算：附件只计信封文本，不计 base64 二进制（既有决策，不得回退成按长度折算）', () => {
  const estimator = new TokenEstimator();
  const huge = 'A'.repeat(200_000);
  const envelopeOnly = estimator.estimateMessages([
    { content: '', images: [{ url: 'https://x/y.png', mediaType: 'image/png' }] },
  ]);
  const withBinary = estimator.estimateMessages([
    { content: '', images: [{ url: huge, mediaType: 'image/png' }] },
  ]);
  assert.ok(withBinary > envelopeOnly, 'URL 文本本身确实随请求发出，必须计入');
  assert.ok(
    withBinary - envelopeOnly < 60_000,
    `二进制载荷不得按长度折算（实测差值 ${String(withBinary - envelopeOnly)}，说明算进了 base64）`,
  );
});

test('Token 估算：accountableText 无附加载荷时逐字等于 content（缓存命中不受影响）', () => {
  assert.strictEqual(TokenEstimator.accountableText({ content: 'abc' }), 'abc');
  assert.match(
    TokenEstimator.accountableText({
      content: 'a',
      reasoningContent: 'b',
      toolCalls: [{ name: 'n', arguments: {} }],
      files: [{ name: 'f.txt', mediaType: 'text/plain' }],
    }),
    /^a\u0000b\u0000/,
  );
});
