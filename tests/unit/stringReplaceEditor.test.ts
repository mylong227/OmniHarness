import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StringReplaceEditor } from '../../src/adapters/tool/fs/stringReplaceEditor.js';

const editor = new StringReplaceEditor();

test('StringReplaceEditor：唯一命中时精确替换', () => {
  const outcome = editor.replace('a\nb\nc', { oldText: 'b', newText: 'B' });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.content, 'a\nB\nc');
  assert.strictEqual(outcome.matchKind, 'exact');
  assert.strictEqual(outcome.line, 2);
  assert.strictEqual(outcome.replacements, 1);
});

test('StringReplaceEditor：多处命中且未开 replace_all 时拒绝（绝不猜改哪一处）', () => {
  const outcome = editor.replace('x\nx\n', { oldText: 'x', newText: 'y' });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error ?? '', /出现 2 次/);
  assert.match(outcome.error ?? '', /replace_all/);
});

test('StringReplaceEditor：replace_all 替换全部命中', () => {
  const outcome = editor.replace('x\nx\n', { oldText: 'x', newText: 'y', replaceAll: true });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.content, 'y\ny\n');
  assert.strictEqual(outcome.replacements, 2);
});

test('StringReplaceEditor：old_string 为空时明确拒绝并指向 write_file', () => {
  const outcome = editor.replace('abc', { oldText: '', newText: 'x' });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error ?? '', /write_file/);
});

test('StringReplaceEditor：缩进层级写错时经空白折叠命中', () => {
  const original = 'function f() {\n    return 1;\n}\n';
  const outcome = editor.replace(original, { oldText: 'return 1;', newText: 'return 2;' });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.content, 'function f() {\n    return 2;\n}\n');
});

test('StringReplaceEditor：CRLF 与行尾空白差异经空白折叠命中', () => {
  const original = 'a  \r\nb\r\nc\r\n';
  const outcome = editor.replace(original, { oldText: 'a\nb', newText: 'A\nB' });
  assert.strictEqual(outcome.ok, true);
  // 折叠匹配把 `a  \r\nb` 整体视作一处（差异空白随被替换段一起消失）。
  assert.strictEqual(outcome.content, 'A\nB\r\nc\r\n');
  assert.strictEqual(outcome.matchKind, 'whitespace');
});

test('StringReplaceEditor：整段粘贴 read_file 的带行号内容（含前缀）仍能命中', () => {
  const original = 'const a = 1;\nconst b = 2;\n';
  const outcome = editor.replace(original, {
    oldText: '1→const a = 1;\n2→const b = 2;',
    newText: 'const a = 10;\nconst b = 20;',
  });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.matchKind, 'line-numbers');
  assert.strictEqual(outcome.content, 'const a = 10;\nconst b = 20;\n');
});

test('StringReplaceEditor：fuzzy=false 时强制精确，不再兜底', () => {
  const outcome = editor.replace('a  \nb\n', { oldText: 'a\nb', newText: 'X', fuzzy: false });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error ?? '', /禁用模糊匹配/);
});

test('StringReplaceEditor：完全不存在时给出可行动错误', () => {
  const outcome = editor.replace('abc', { oldText: 'zzz', newText: 'y' });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error ?? '', /read_file/);
});

test('StringReplaceEditor：new_string 为空串即删除该片段', () => {
  const outcome = editor.replace('keep\nremove\nkeep2\n', { oldText: 'remove\n', newText: '' });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.content, 'keep\nkeep2\n');
});
