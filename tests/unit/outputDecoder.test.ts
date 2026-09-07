import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputDecoder } from '../../src/util/outputDecoder.js';

test('输出解码：UTF-8 文本正常解码', () => {
  const decoder = new OutputDecoder();
  const buffer = Buffer.from('OmniHarness utf8', 'utf8');
  assert.strictEqual(decoder.decode(buffer), 'OmniHarness utf8');
});

test('输出解码：GBK 字节回退解码为中文', () => {
  const decoder = new OutputDecoder();
  // '中文' 的 GBK 编码字节序列（中=D6D0, 文=CEC4）
  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.strictEqual(decoder.decode(gbkBytes), '中文');
});

test('输出解码：纯 ASCII 不受影响', () => {
  const decoder = new OutputDecoder();
  assert.strictEqual(decoder.decode(Buffer.from('hello world', 'ascii')), 'hello world');
});

test('输出解码：空 Buffer 返回空串', () => {
  const decoder = new OutputDecoder();
  assert.strictEqual(decoder.decode(Buffer.alloc(0)), '');
});
