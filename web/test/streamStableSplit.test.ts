import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StreamStableSplit } from '../src/ui/models/StreamStableSplit.ts';

test('StreamStableSplit：无空行时全部留在尾部（简单文本 textContent 不变）', () => {
  const r = StreamStableSplit.split('正在分析…');
  assert.strictEqual(r.stable, '');
  assert.strictEqual(r.tail, '正在分析…');
});

test('StreamStableSplit：最后一个空行前切分，tail 保留分隔符', () => {
  const text = '第一段内容。\n\n第二段内容。';
  const r = StreamStableSplit.split(text);
  assert.strictEqual(r.stable, '第一段内容。');
  assert.strictEqual(r.tail, '\n\n第二段内容。');
  assert.strictEqual(r.stable + r.tail, text);
});

test('StreamStableSplit：fenced code 内空行不切', () => {
  const text = '前言\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n结尾';
  const r = StreamStableSplit.split(text);
  assert.ok(r.stable.endsWith('```'), '稳定段应包含已闭合代码块');
  assert.strictEqual(r.tail, '\n\n结尾');
});

test('StreamStableSplit：未闭合 fence 时，fence 前最后空行仍是切点', () => {
  const text = '前言\n\n```ts\nconst a = 1;\n\nconst b = 2;';
  const r = StreamStableSplit.split(text);
  assert.strictEqual(r.stable, '前言');
  assert.strictEqual(r.tail, '\n\n```ts\nconst a = 1;\n\nconst b = 2;');
});
