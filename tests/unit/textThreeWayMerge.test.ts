/**
 * 行级三方合并判据。
 *
 * 覆盖：双方改不同位置 ⇒ 干净合并；双方改同一位置 ⇒ 冲突；相同改动 ⇒ 去重；
 * 插入/删除边界；行尾换行保真；超限回退。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TextThreeWayMerge } from '../../src/util/textThreeWayMerge.ts';

test('① 双方改不同位置 ⇒ 干净合并，两个改动都保留', () => {
  const result = TextThreeWayMerge.merge('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ok ? result.content : '', 'A\nb\nC\n');
});

test('② 双方改同一位置且结果不同 ⇒ 冲突，不猜', () => {
  const result = TextThreeWayMerge.merge('a\nb\n', 'A\nb\n', 'X\nb\n');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? '' : result.reason, 'conflict');
  assert.strictEqual(result.ok ? 0 : result.conflicts.length, 1);
});

test('③ 双方改成同样内容 ⇒ 视为一致（不产生假冲突）', () => {
  const result = TextThreeWayMerge.merge('a\nb\n', 'A\nb\n', 'A\nb\n');
  assert.deepStrictEqual(result, { ok: true, content: 'A\nb\n' });
});

test('④ 一方未改 ⇒ 直接取另一方（快路径）', () => {
  assert.deepStrictEqual(TextThreeWayMerge.merge('a\n', 'a\n', 'b\n'), {
    ok: true,
    content: 'b\n',
  });
  assert.deepStrictEqual(TextThreeWayMerge.merge('a\n', 'b\n', 'a\n'), {
    ok: true,
    content: 'b\n',
  });
});

test('⑤ 不同位置的插入可叠加；同一位置的插入冲突', () => {
  const clean = TextThreeWayMerge.merge('a\nb\n', 'a\nX\nb\n', 'a\nb\nY\n');
  assert.strictEqual(clean.ok, true);
  assert.strictEqual(clean.ok ? clean.content : '', 'a\nX\nb\nY\n');
  const conflict = TextThreeWayMerge.merge('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n');
  assert.strictEqual(conflict.ok, false);
});

test('⑥ 删除 + 另一侧改别处 ⇒ 合并；删除与改同段 ⇒ 冲突', () => {
  const clean = TextThreeWayMerge.merge('a\nb\nc\n', 'a\nc\n', 'A\nb\nc\n');
  assert.strictEqual(clean.ok, true);
  assert.strictEqual(clean.ok ? clean.content : '', 'A\nc\n');
  const conflict = TextThreeWayMerge.merge('a\nb\nc\n', 'a\nc\n', 'a\nB2\nc\n');
  assert.strictEqual(conflict.ok, false);
});

test('⑦ 末尾换行保真：合并不吞/不多加换行', () => {
  const result = TextThreeWayMerge.merge('a\nb', 'A\nb', 'a\nb');
  assert.deepStrictEqual(result, { ok: true, content: 'A\nb' });
});

test('⑧ 超限回退：矩阵超过上限时返回 too-large，而不是耗尽内存', () => {
  const lines = Array.from({ length: 1_600 }, (_, i) => `line-${String(i)}`);
  const base = lines.join('\n');
  const ours = lines.map((line, i) => (i === 0 ? `${line}-ours` : line)).join('\n');
  const theirs = lines
    .map((line, i) => (i === lines.length - 1 ? `${line}-theirs` : line))
    .join('\n');
  const result = TextThreeWayMerge.merge(base, ours, theirs);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? '' : result.reason, 'too-large');
});

test('⑨ 同一行不同位置之外的多行改写：区间相交即冲突', () => {
  const result = TextThreeWayMerge.merge('a\nb\nc\n', 'a\nB1\nC1\n', 'a\nB2\nC2\n');
  assert.strictEqual(result.ok, false);
});

test('⑩ 真实代码片段：不同函数各改一处 ⇒ 两个改动都保留', () => {
  const base = [
    'export function a() {',
    '  return 1;',
    '}',
    '',
    'export function b() {',
    '  return 2;',
    '}',
    '',
  ].join('\n');
  const ours = base.replace('return 1;', 'return 10;');
  const theirs = base.replace('return 2;', 'return 20;');
  const result = TextThreeWayMerge.merge(base, ours, theirs);
  assert.strictEqual(result.ok, true);
  const merged = result.ok ? result.content : '';
  assert.match(merged, /return 10;/);
  assert.match(merged, /return 20;/);
});
