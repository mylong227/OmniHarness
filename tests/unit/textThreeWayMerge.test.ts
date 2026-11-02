/**
 * 行级三方合并判据。
 *
 * 覆盖：双方改不同位置 ⇒ 干净合并；双方改同一位置 ⇒ 冲突；相同改动 ⇒ 去重；
 * 插入/删除边界；行尾换行保真；超限回退。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TextThreeWayMerge } from '../../src/kernel/util/textThreeWayMerge.ts';

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

// ── 行尾保真（2026-10-30 研究 EDIT_CONCURRENCY_RESEARCH：探针 F/F2 抓到的真缺陷）──
// 缺陷形态：行切分用 `\n`，CRLF 的 `\r` 留在行内容里；两侧都动同一区域时会走字符级细化，
// 字符级 LCS 把 `\r` 当可丢弃差异匹配掉 ⇒ 整个文件被**静默改写成 LF**（git diff 全文件改写）。

test('⑪ CRLF base + 对方整份 LF ⇒ 干净合并且**CRLF 保留**', () => {
  const result = TextThreeWayMerge.merge('a\r\nb\r\n', 'A\r\nb\r\n', 'a\nB\n');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ok ? result.content : '', 'A\r\nB\r\n', '不得把 CRLF 改写成 LF');
});

test('⑫ CRLF base、两侧各改一行（对方整份 LF）⇒ 合并后仍是 CRLF，无混合行尾', () => {
  const result = TextThreeWayMerge.merge('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\nb\nC\n');
  assert.strictEqual(result.ok, true);
  const merged = result.ok ? result.content : '';
  assert.strictEqual(merged, 'A\r\nb\r\nC\r\n', '结果必须沿用 base 的 CRLF');
  assert.doesNotMatch(merged.replace(/\r\n/gu, ''), /\n/u, '不得出现裸 \\n（混合行尾）');
});

test('⑬ 对称方向：LF base + 对方整份 CRLF ⇒ 合并后仍是 LF', () => {
  const result = TextThreeWayMerge.merge('a\nb\n', 'A\nb\n', 'a\r\nB\r\n');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ok ? result.content : '', 'A\nB\n', '不得被对方的 CRLF 带偏');
});

test('⑭ base 本身混行尾 ⇒ 原样保留，不替作者"顺手统一"', () => {
  const result = TextThreeWayMerge.merge('a\r\nb\nc\n', 'A\r\nb\nc\n', 'a\r\nb\nC\n');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ok ? result.content : '', 'A\r\nb\nC\n', '混行尾是现状，不得被归一');
});
