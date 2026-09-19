import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileLineWindow } from '../../src/adapters/tool/fs/fileLineWindow.js';

test('FileLineWindow：默认整文件带行号', () => {
  const result = FileLineWindow.slice('a\nb\nc');
  assert.strictEqual(result.text, '1→a\n2→b\n3→c');
  assert.strictEqual(result.startLine, 1);
  assert.strictEqual(result.endLine, 3);
  assert.strictEqual(result.totalLines, 3);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.pastEnd, false);
});

test('FileLineWindow：numbered=false 时与文件逐字一致', () => {
  assert.strictEqual(FileLineWindow.slice('a\nb\nc', { numbered: false }).text, 'a\nb\nc');
});

test('FileLineWindow：offset/limit 取窗口并标记还有更多行', () => {
  const result = FileLineWindow.slice('a\nb\nc\nd\ne', { offset: 2, limit: 2 });
  assert.strictEqual(result.text, '2→b\n3→c');
  assert.strictEqual(result.startLine, 2);
  assert.strictEqual(result.endLine, 3);
  assert.strictEqual(result.totalLines, 5);
  assert.strictEqual(result.truncated, true);
});

test('FileLineWindow：行号宽度按窗口最大行号对齐', () => {
  const lines = Array.from({ length: 12 }, (_, index) => `L${index + 1}`).join('\n');
  const result = FileLineWindow.slice(lines, { offset: 9, limit: 3 });
  assert.strictEqual(result.text, ' 9→L9\n10→L10\n11→L11');
});

test('FileLineWindow：offset 越过末尾时回报 pastEnd 而不是抛错', () => {
  const result = FileLineWindow.slice('a\nb', { offset: 9 });
  assert.strictEqual(result.pastEnd, true);
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.totalLines, 2);
});

test('FileLineWindow：空文件视为 0 行', () => {
  const result = FileLineWindow.slice('');
  assert.strictEqual(result.totalLines, 0);
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.pastEnd, false);
});

test('FileLineWindow：limit 被钳制在 [1, MAX_LINES]', () => {
  assert.strictEqual(FileLineWindow.slice('a\nb', { limit: 0 }).text, '1→a');
  assert.strictEqual(FileLineWindow.slice('a\nb', { limit: 99999 }).endLine, 2);
  assert.strictEqual(FileLineWindow.slice('a\nb', { limit: Number.NaN }).endLine, 2);
});
