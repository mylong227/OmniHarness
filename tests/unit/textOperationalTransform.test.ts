/**
 * 插入 OT 判据：成对变换的交换律（apply(a) then b' == apply(b) then a'）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TextOperationalTransform } from '../../src/util/textOperationalTransform.ts';
import type { TextInsertOperation } from '../../src/util/textOperationalTransform.ts';

/** 所有合法插入（文本 "abcd" 上位置 0..4，插入 X/Y）。 */
function operations(length: number): TextInsertOperation[] {
  const out: TextInsertOperation[] = [];
  for (let position = 0; position <= length; position += 1) {
    out.push({ position, text: 'X' });
    out.push({ position, text: 'Y' });
  }
  return out;
}

test('① apply：插入位置边界与空操作', () => {
  assert.strictEqual(TextOperationalTransform.apply('abc', { position: 0, text: 'X' }), 'Xabc');
  assert.strictEqual(TextOperationalTransform.apply('abc', { position: 3, text: 'X' }), 'abcX');
  assert.strictEqual(TextOperationalTransform.apply('abc', { position: 1, text: '' }), 'abc');
  assert.throws(
    () => TextOperationalTransform.apply('abc', { position: 4, text: 'X' }),
    RangeError,
  );
});

test('② 成对变换交换律：所有位置 × 所有文本组合', () => {
  const base = 'abcd';
  const ops = operations(base.length);
  for (const a of ops) {
    for (const b of ops) {
      const { aPrime, bPrime } = TextOperationalTransform.transform(a, b);
      const left = TextOperationalTransform.apply(TextOperationalTransform.apply(base, a), bPrime);
      const right = TextOperationalTransform.apply(TextOperationalTransform.apply(base, b), aPrime);
      assert.strictEqual(left, right, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    }
  }
});

test('③ 同位置同文本仍保留两次插入；同位置不同文本字典序定序', () => {
  const same = TextOperationalTransform.transform(
    { position: 1, text: 'X' },
    { position: 1, text: 'X' },
  );
  const doubled = TextOperationalTransform.apply(
    TextOperationalTransform.apply('ab', same.aPrime),
    same.bPrime,
  );
  assert.strictEqual(doubled, 'aXXb');
  const pair = TextOperationalTransform.transform(
    { position: 1, text: 'B' },
    { position: 1, text: 'A' },
  );
  // A 字典序在前 ⇒ 先 A 后 B。
  const result = TextOperationalTransform.apply(
    TextOperationalTransform.apply('xy', pair.bPrime),
    pair.aPrime,
  );
  assert.strictEqual(result, 'xABy');
});

test('④ 不同位置插入：两个字符都保留', () => {
  const { aPrime, bPrime } = TextOperationalTransform.transform(
    { position: 0, text: 'A' },
    { position: 4, text: 'B' },
  );
  const result = TextOperationalTransform.apply(
    TextOperationalTransform.apply('wxyz', aPrime),
    bPrime,
  );
  assert.strictEqual(result, 'AwxyzB');
});
