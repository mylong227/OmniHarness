// @vitest-environment jsdom
// 排队消息坞（2026-10-31）组件判据：收起只显示下一条、点击向上展开全部、可滚动列表、
// 置顶 / 删除 / 清空 / 暂停恢复的交互与无障碍名。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderUi } from './rtlHarness.ts';
import { ChatQueueDock } from '../src/ui/components/ChatQueueDock.tsx';
import type { ChatQueueView, QueuedMessage } from '../src/ui/models/ChatMessageQueue.ts';

/** 造一条排队项。 */
function item(id: string, prompt: string, withAttachment = false): QueuedMessage {
  return {
    id,
    prompt,
    images: withAttachment ? [{ mediaType: 'image/gif', data: 'AAAA' }] : [],
    files: withAttachment ? [{ name: 'spec.md', mediaType: 'text/markdown', data: 'BBBB' }] : [],
    threadId: 't1',
    createdAt: 1,
    priority: false,
  };
}

/** 造队列视图桩（记录回调）。 */
function queueOf(items: QueuedMessage[], paused = false) {
  const calls: string[] = [];
  const queue: ChatQueueView = {
    mode: 'queue',
    items,
    paused,
    busy: true,
    onRemove: (id) => calls.push('remove:' + id),
    onPromote: (id) => calls.push('promote:' + id),
    onClear: () => calls.push('clear'),
    onResume: () => calls.push('resume'),
  };
  return { queue, calls };
}

test('无排队项时不渲染任何东西', () => {
  const { queue } = queueOf([]);
  const ui = renderUi(ChatQueueDock, { props: { queue } });
  assert.strictEqual(ui.root, null);
});

test('收起态只显示下一条与条数；点击抬头向上展开全部（可滚动列表）', () => {
  const { queue } = queueOf([item('a', '第一条'), item('b', '第二条'), item('c', '第三条')]);
  const ui = renderUi(ChatQueueDock, { props: { queue } });
  const root = ui.container.querySelector('.chat-queue');
  assert.ok(root !== null);
  assert.strictEqual(root.getAttribute('data-queue-count'), '3');
  // 收起态：没有任何列表项，只有抬头（下一条 + 条数）。
  assert.strictEqual(ui.container.querySelectorAll('.cq-item').length, 0);
  const head = ui.container.querySelector('.cq-head');
  assert.ok(head !== null);
  assert.strictEqual(head.getAttribute('aria-expanded'), 'false');
  assert.ok(head.textContent?.includes('第一条'), '收起态应展示下一条');
  assert.ok(head.textContent?.includes('3'), '收起态应展示条数');

  fireEvent.click(head);
  const expanded = ui.container.querySelector('.cq-head');
  assert.strictEqual(expanded?.getAttribute('aria-expanded'), 'true');
  const rows = ui.container.querySelectorAll('.cq-item');
  assert.strictEqual(rows.length, 3, '展开后必须列出全部排队项');
  const text = Array.from(rows)
    .map((r) => r.textContent ?? '')
    .join(' | ');
  assert.ok(text.includes('第一条') && text.includes('第二条') && text.includes('第三条'));
  // 列表容器是滚动容器（CSS max-height + overflow:auto 的挂点）。
  assert.ok(ui.container.querySelector('.cq-list') !== null);
});

test('展开后：置顶 / 删除 / 清空分别回调，按钮有无障碍名', () => {
  const { queue, calls } = queueOf([item('a', '第一条'), item('b', '第二条')]);
  const ui = renderUi(ChatQueueDock, { props: { queue } });
  fireEvent.click(ui.container.querySelector('.cq-head')!);

  const pins = ui.container.querySelectorAll('.cq-pin');
  assert.strictEqual(pins[0]?.hasAttribute('disabled'), true, '第一条已在队首，置顶应禁用');
  fireEvent.click(pins[1]!);
  const dels = ui.container.querySelectorAll('.cq-del');
  fireEvent.click(dels[0]!);
  fireEvent.click(ui.container.querySelector('.cq-clear')!);
  assert.deepStrictEqual(calls, ['promote:b', 'remove:a', 'clear']);
  assert.ok((pins[1]?.getAttribute('aria-label') ?? '').includes('2'));
  assert.ok((dels[0]?.getAttribute('aria-label') ?? '').includes('1'));
});

test('附件（GIF / 文件 / 视频）在展开项里可见', () => {
  const { queue } = queueOf([item('a', '带附件', true), item('b', '纯文本')]);
  const ui = renderUi(ChatQueueDock, { props: { queue } });
  fireEvent.click(ui.container.querySelector('.cq-head')!);
  const thumbs = ui.container.querySelectorAll('.cq-thumb, .cq-file');
  assert.strictEqual(thumbs.length, 2, '一个 GIF 缩略图 + 一个文件 chip');
  assert.ok((ui.container.querySelector('.cq-atts-count')?.textContent ?? '').includes('2'));
});

test('暂停态显示恢复按钮，点击回调 onResume', () => {
  const { queue, calls } = queueOf([item('a', '第一条')], true);
  const ui = renderUi(ChatQueueDock, { props: { queue } });
  const paused = ui.container.querySelector('.cq-paused');
  assert.ok(paused !== null);
  fireEvent.click(ui.container.querySelector('.cq-resume')!);
  assert.deepStrictEqual(calls, ['resume']);
});
