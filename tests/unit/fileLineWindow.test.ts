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

test('FileLineWindow：字节预算截断超长单行并显式标记（2026-10-03 修 T1）', () => {
  // 单行 2 MiB：行数上限 5000 对一行式 minified bundle 形同虚设 ⇒ 旧实现整行 2 MiB 进上下文。
  const oneLine = 'x'.repeat(2 * 1024 * 1024);
  const result = FileLineWindow.slice(oneLine, {});
  assert.ok(result.truncated);
  assert.match(result.text, /字节预算/);
  // 首行自身超预算也必须保留 1 行（不允许出现空窗口）。
  assert.ok(result.text.includes('xxxx'));
});

test('FileLineWindow：多行超预算停在预算内，已返回行数明确（2026-10-03 修 T1）', () => {
  // 每行约 4 KiB × 500 行 ≈ 2 MiB：行数上限（5000）拦不住，只有字节预算拦得住。
  const lines = Array.from({ length: 500 }, (_v, i) => `line-${String(i)}-${'y'.repeat(4000)}`);
  const windowed = FileLineWindow.slice(lines.join('\n'), {});
  assert.ok(windowed.truncated);
  assert.match(windowed.text, /已返回 \d+\/\d+ 行/);
  // 已返回行数必须远小于 500（512KiB / ~4KiB ≈ 130 行处停住）且大于 0。
  const match = /已返回 (\d+)\/(\d+) 行/.exec(windowed.text);
  assert.ok(match !== null);
  assert.ok(Number(match[1]) > 0 && Number(match[1]) < 200);
});
