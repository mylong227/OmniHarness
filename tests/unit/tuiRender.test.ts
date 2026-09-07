import { strict as assert } from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough, type Writable } from 'node:stream';
import {
  clearLine,
  prompt,
  renderEventLine,
  renderStatusLine,
  truncateToWidth,
  type TuiEvent,
} from '../../src/tui/render.js';
import { renderStream } from '../../src/tui/interactive.js';

function collect(out: Writable): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    out.on('data', (c) => chunks.push(String(c)));
    out.on('end', () => resolve(chunks.join('')));
    out.on('finish', () => resolve(chunks.join('')));
  });
}

test('truncateToWidth 按近似宽度截断并加省略号', () => {
  assert.strictEqual(truncateToWidth('hello', 10), 'hello');
  assert.strictEqual(truncateToWidth('hello world', 5), 'hello…');
  assert.strictEqual(truncateToWidth('你好世界', 4), '你好…'); // 每个 CJK 计 2 宽，恰满 4 后截断
  assert.strictEqual(truncateToWidth('abc', 0), '');
});

test('renderEventLine 带 ANSI 颜色与前缀，且能区分类型', () => {
  const a = renderEventLine({ kind: 'assistant', text: '在思考' });
  const t = renderEventLine({ kind: 'tool_call', text: 'ls', meta: 'bash' });
  assert.match(a, /在思考/);
  assert.match(a, /◆/);
  assert.match(t, /ls/);
  assert.match(t, /⚙/);
  assert.match(t, /\[bash\]/);
});

test('renderStatusLine 含状态文本', () => {
  assert.match(renderStatusLine('运行中'), /运行中/);
  assert.match(renderStatusLine('暂停', '等待'), /暂停/);
});

test('clearLine / prompt 返回转义序列', () => {
  assert.match(clearLine(), /\x1b\[2K/);
  assert.match(prompt(), />/);
});

test('renderStream 把事件流逐行渲染（含错误事件）', async () => {
  const out = new PassThrough();
  const done = collect(out);
  const events: TuiEvent[] = [
    { kind: 'assistant', text: '先列目录' },
    { kind: 'tool_call', text: 'ls', meta: 'bash' },
    { kind: 'tool_result', text: 'a b c' },
  ];
  async function* gen() {
    for (const e of events) yield e;
  }
  await renderStream(gen(), out);
  out.end();
  const text = await done;
  const lines = text.trim().split('\n');
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0] ?? '', /先列目录/);
  assert.match(lines[1] ?? '', /ls/);
  assert.match(lines[2] ?? '', /a b c/);
});
