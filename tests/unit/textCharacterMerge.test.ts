/**
 * 字符级三方合并判据（行级冲突的同一行细化）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TextCharacterMerge } from '../../src/util/textCharacterMerge.ts';
import { TextThreeWayMerge } from '../../src/util/textThreeWayMerge.ts';

test('① 同一行改不同字符区间 ⇒ 字符级合并', () => {
  const result = TextCharacterMerge.merge(
    'const value = 1;',
    'const value = 2;',
    'const value = 1; // note',
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.content, 'const value = 2; // note');
});

test('② 同一字符区间改成不同内容 ⇒ 冲突', () => {
  const result = TextCharacterMerge.merge(
    'const value = 1;',
    'const value = 2;',
    'const value = 3;',
  );
  assert.strictEqual(result.ok, false);
});

test('③ 行级 diff3 自动调用字符级细化（同线不同区间）', () => {
  const result = TextThreeWayMerge.merge(
    'const value = 1;\n',
    'const value = 2;\n',
    'const value = 1; // note\n',
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ok ? result.content : '', 'const value = 2; // note\n');
});

test('④ 字符级冲突时仍返回行级冲突（不静默合并）', () => {
  const result = TextThreeWayMerge.merge('a = 1;\n', 'a = 2;\n', 'a = 3;\n');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? '' : result.reason, 'conflict');
});

test('⑤ 字符级插入/删除边界：不同位置的插入可叠加', () => {
  const result = TextCharacterMerge.merge('abc', 'Xabc', 'abcY');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.content, 'XabcY');
});
