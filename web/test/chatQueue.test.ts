// 聊天消息队列（2026-10-31「队列模式」）的纯逻辑判据。
//
// 只测 `models/ChatMessageQueue.ts` / `models/ChatModePreference.ts`：零 React、零 DOM、零 RPC。
// 队列最贵的两个错误是「串台」（A 会话的消息发进 B）与「丢消息」（停止后静默丢弃），
// 这里把它们逐条钉死。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ChatMessageQueue, ChatQueuePreview } from '../src/ui/models/ChatMessageQueue.ts';
import { ChatModePreference, DEFAULT_CHAT_MODE } from '../src/ui/models/ChatModePreference.ts';

/** 构造一条入队入参。 */
function input(prompt: string, threadId: string | null = 't1') {
  return { prompt, images: [], files: [], threadId };
}

test('入队按 FIFO；插队项排到队首；takeNext 逐条取出', () => {
  const q = new ChatMessageQueue();
  q.enqueue(input('第一条'), 1);
  q.enqueue(input('第二条'), 2);
  q.enqueue({ ...input('插队'), priority: true }, 3);
  assert.deepStrictEqual(
    q.all().map((m) => m.prompt),
    ['插队', '第一条', '第二条'],
  );
  assert.strictEqual(q.takeNext('t1')?.prompt, '插队');
  assert.strictEqual(q.takeNext('t1')?.prompt, '第一条');
  assert.strictEqual(q.takeNext('t1')?.prompt, '第二条');
  assert.strictEqual(q.takeNext('t1'), null, '取空后必须返回 null，不能返回 undefined');
});

test('会话隔离：A 会话的排队不会被 B 会话取走（也不在 B 的视图里）', () => {
  const q = new ChatMessageQueue();
  q.enqueue(input('给 A', 'tA'));
  q.enqueue(input('给 B', 'tB'));
  // 未创建会话时入队（null）对任何会话可见——首条消息建会话的场景。
  q.enqueue(input('无主', null));
  assert.deepStrictEqual(
    q.forThread('tA').map((m) => m.prompt),
    ['给 A', '无主'],
  );
  assert.strictEqual(q.takeNext('tA')?.prompt, '给 A');
  assert.strictEqual(q.takeNext('tA')?.prompt, '无主');
  assert.strictEqual(q.takeNext('tA'), null);
  assert.deepStrictEqual(
    q.forThread('tB').map((m) => m.prompt),
    ['给 B'],
    'A 取走后 B 的消息必须原样还在',
  );
});

test('删除 / 置顶 / 清空只作用于目标项与当前会话', () => {
  const q = new ChatMessageQueue();
  const a = q.enqueue(input('A1', 'tA'), 1);
  q.enqueue(input('A2', 'tA'), 2);
  q.enqueue(input('B1', 'tB'), 3);
  assert.strictEqual(q.remove(a.id), true);
  assert.strictEqual(q.remove('missing'), false);
  assert.deepStrictEqual(
    q.forThread('tA').map((m) => m.prompt),
    ['A2'],
  );
  const b1 = q.forThread('tB')[0];
  assert.ok(b1 !== undefined);
  assert.strictEqual(q.promote(b1.id), true, '置顶应成功');
  assert.strictEqual(q.all()[0]?.prompt, 'B1');
  assert.strictEqual(q.clear('tA'), 1, '清空只清当前会话（A2 一条）');
  assert.deepStrictEqual(
    q.all().map((m) => m.prompt),
    ['B1'],
    '别的会话的项必须留下',
  );
});

test('队列项保留多模态附件：图片 / 视频 GIF / 文件 / 链接都随项带走', () => {
  const q = new ChatMessageQueue();
  const item = q.enqueue({
    prompt: '看这个 https://example.com/a.png',
    images: [{ mediaType: 'image/png', data: 'AAAA' }],
    files: [
      { name: 'demo.mp4', mediaType: 'video/mp4', data: 'BBBB' },
      { name: 'anim.gif', mediaType: 'image/gif', data: 'CCCC' },
      { name: 'spec.md', mediaType: 'text/markdown', data: 'DDDD' },
    ],
    threadId: 't1',
  });
  assert.strictEqual(item.images.length, 1);
  assert.strictEqual(item.files.length, 3);
  const views = ChatQueuePreview.attachmentsOf(item);
  assert.deepStrictEqual(
    views.map((v) => v.kind),
    ['image', 'video', 'image', 'file'],
    'gif 属图片、mp4 属视频、md 属文件',
  );
  assert.strictEqual(views[0]?.previewUrl, 'data:image/png;base64,AAAA');
  assert.deepStrictEqual(ChatQueuePreview.linksOf(item), ['https://example.com/a.png']);
});

test('纯附件项的摘要不显示为空（用户要能看出"有东西在排队"）', () => {
  const q = new ChatMessageQueue();
  const item = q.enqueue({
    prompt: '   ',
    images: [{ mediaType: 'image/gif', data: 'X' }],
    files: [{ name: 'a.pdf', mediaType: 'application/pdf' }],
    threadId: 't1',
  });
  const summary = ChatQueuePreview.summaryOf(item);
  assert.ok(summary.includes('2'), `纯附件摘要应含附件数，实际: ${summary}`);
  assert.strictEqual(ChatQueuePreview.countOf(item), 2);
});

test('聊天模式偏好：非法值回落队列模式；parse 只认 queue/steer', () => {
  assert.strictEqual(DEFAULT_CHAT_MODE, 'queue');
  assert.strictEqual(ChatModePreference.parse('steer'), 'steer');
  assert.strictEqual(ChatModePreference.parse('queue'), 'queue');
  assert.strictEqual(ChatModePreference.parse('nope'), 'queue');
  assert.strictEqual(ChatModePreference.parse(undefined), 'queue');
  assert.strictEqual(ChatModePreference.labelOf('steer'), '插话模式');
  assert.strictEqual(ChatModePreference.labelOf('queue'), '队列模式');
});
