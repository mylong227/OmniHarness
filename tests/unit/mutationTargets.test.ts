import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MutationTargets } from '../../src/adapters/tool/verify/mutationTargets.js';

test('MutationTargets.of：write_file / edit 取显式 path', () => {
  assert.deepStrictEqual([...MutationTargets.of('write_file', { path: 'src/a.ts' })], ['src/a.ts']);
  assert.deepStrictEqual([...MutationTargets.of('edit', { path: 'src/b.ts' })], ['src/b.ts']);
});

test('MutationTargets.of：apply_patch 省略 path 时仍能从 +++ 头解析出目标（回归自验证旁路）', () => {
  // 这是 2026-09-19 探针实测失败的那一例：官方描述里 apply_patch 的 path 可省略。
  const args = { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n' };
  assert.deepStrictEqual([...MutationTargets.of('apply_patch', args)], ['src/a.ts']);
});

test('MutationTargets.of：多文件补丁给出全部目标且去重', () => {
  const patch = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-u',
    '+v',
  ].join('\n');
  assert.deepStrictEqual(
    [...MutationTargets.of('apply_patch', { patch })],
    ['src/a.ts', 'src/b.ts'],
  );
  // 显式 path 与补丁头重复时只保留一份。
  assert.deepStrictEqual(
    [...MutationTargets.of('apply_patch', { path: 'src/a.ts', patch })],
    ['src/a.ts', 'src/b.ts'],
  );
});

test('MutationTargets.of：非落盘工具与空 path 一律为空（fail-closed，不乱报目标）', () => {
  assert.deepStrictEqual([...MutationTargets.of('shell', { command: 'rm -rf /' })], []);
  assert.deepStrictEqual([...MutationTargets.of('read_file', { path: 'src/a.ts' })], []);
  assert.deepStrictEqual([...MutationTargets.of('write_file', { path: '' })], []);
  assert.deepStrictEqual([...MutationTargets.of('apply_patch', { patch: '不是补丁' })], []);
});

test('MutationTargets.addedText：write_file 取 content、edit 取 new_string', () => {
  assert.strictEqual(MutationTargets.addedText('write_file', { content: 'hello' }), 'hello');
  assert.strictEqual(MutationTargets.addedText('edit', { new_string: 'world' }), 'world');
  assert.strictEqual(MutationTargets.addedText('shell', { content: 'hello' }), undefined);
});

test('MutationTargets.addedText：apply_patch 只取新增行且排除 +++ 头', () => {
  const patch = ['--- a/f.ts', '+++ b/f.ts', '@@ -1 +1 @@', '-old', '+new1', '+new2'].join('\n');
  assert.strictEqual(MutationTargets.addedText('apply_patch', { patch }), 'new1\nnew2');
  const deletionsOnly = ['--- a/f.ts', '+++ b/f.ts', '@@ -1 +0,0 @@', '-old'].join('\n');
  assert.strictEqual(MutationTargets.addedText('apply_patch', { patch: deletionsOnly }), undefined);
});
