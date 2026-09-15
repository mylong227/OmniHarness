/**
 * P3 测试失败摘要提取单测（零依赖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestFailureDigest } from '../../src/adapters/tool/verify/testFailureDigest.js';

test('从 node --test 风格输出抽出失败行', () => {
  const raw = [
    '# tests 3',
    'ok 1 - 通过用例',
    'not ok 2 - 失败用例',
    '  ---',
    '  AssertionError: expected 1 to equal 2',
    '# tests 3',
    '# pass 2',
    '# fail 1',
  ].join('\n');
  const digest = TestFailureDigest.from(raw, 10);
  assert.ok(digest.includes('not ok 2 - 失败用例'));
  assert.ok(digest.includes('AssertionError'));
  assert.strictEqual(digest.includes('ok 1 - 通过用例'), false);
});

test('无失败行时回落到输出尾部非空行', () => {
  const raw = ['line-a', 'line-b', '', 'line-c', ''].join('\n');
  const digest = TestFailureDigest.from(raw, 2);
  assert.strictEqual(digest, 'line-b\nline-c');
});

test('摘要行数受 maxLines 限制', () => {
  const raw = ['not ok 1', 'not ok 2', 'not ok 3'].join('\n');
  const digest = TestFailureDigest.from(raw, 2);
  assert.strictEqual(digest.split('\n').length, 2);
});

test('剥除 ANSI 颜色码并去重', () => {
  const raw = ['\u001b[31mFAIL\u001b[0m suite-a', '\u001b[31mFAIL\u001b[0m suite-a'].join('\n');
  const digest = TestFailureDigest.from(raw, 5);
  assert.strictEqual(digest, 'FAIL suite-a');
});

test('空输入返回空串；maxLines<=0 时至少 1 行', () => {
  assert.strictEqual(TestFailureDigest.from('', 5), '');
  assert.strictEqual(TestFailureDigest.from('not ok 1', 0), 'not ok 1');
});

test('pytest / cargo 风格失败行同样被抽到', () => {
  const raw = ['collected 3 items', '===== 1 failed, 2 passed ====='].join('\n');
  const digest = TestFailureDigest.from(raw, 5);
  assert.ok(digest.includes('1 failed, 2 passed'));
});

test('超长行被截断（避免单行撑爆上下文）', () => {
  const raw = `not ok 1 - ${'x'.repeat(1000)}`;
  const digest = TestFailureDigest.from(raw, 3);
  assert.ok(digest.length <= 302, `len=${digest.length}`);
  assert.ok(digest.endsWith('…'));
});
