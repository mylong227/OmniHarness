// ConsoleLiveView 渲染测试（#B3 呈现层）：验证工具参数增量在 TTY 下被累积渲染。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Writable } from 'node:stream';
import { ConsoleLiveView } from '../../src/adapters/live/consoleLiveView.js';
import { renderToolInputProgress } from '../../src/tui/render.js';

/** 内存可写流（模拟 TTY），便于断言渲染输出。 */
class MemStream {
  chunks: string[] = [];
  isTTY = true;
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
}

test('renderToolInputProgress 渲染工具名与参数预览', () => {
  const line = renderToolInputProgress({ name: 'shell.run', json: '{"command":"echo hi"}' });
  assert.match(line, /shell\.run/);
  assert.match(line, /echo hi/);
});

test('ConsoleLiveView 在 TTY 下累积渲染工具参数增量', () => {
  const mem = new MemStream();
  const view = new ConsoleLiveView(mem as unknown as Writable);
  view.onToolInput({ id: 'c1', name: 'shell.run', partialJson: '{"command":"ec' });
  view.onToolInput({ id: 'c1', name: 'shell.run', partialJson: 'ho hi"}' });
  const out = mem.chunks.join('');
  assert.match(out, /shell\.run/);
  assert.match(out, /echo hi/);
});

test('ConsoleLiveView 在非 TTY 下静默（不污染管道）', () => {
  const mem = new MemStream();
  mem.isTTY = false;
  const view = new ConsoleLiveView(mem as unknown as Writable);
  view.onToolInput({ id: 'c1', name: 'shell.run', partialJson: '{"command":"echo' });
  assert.strictEqual(mem.chunks.length, 0, '非 TTY 不应输出');
});
