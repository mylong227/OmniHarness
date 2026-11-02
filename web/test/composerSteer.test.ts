// @vitest-environment jsdom
// busy 时发送的**路由已下沉到 ComposerController**（2026-10-31 聊天模式）：
// Composer 不再自己发 steering RPC，而是统一上抛 onSend，由控制器按「队列 / 插话」模式
// 决定入队、并入当前回合还是中断转新任务。这里钉住「输入区不丢消息、不自己判断」这一层。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync } from './rtlHarness.ts';
import { byClass, byTag, facadeOf } from './domFacade.ts';
import { Composer } from '../src/ui/components/Composer.tsx';
import type { ApiClient } from '../src/kernel/core/ApiClient.ts';
import type { ChatQueueView } from '../src/ui/models/ChatMessageQueue.ts';
import type { FileAttachment } from '../src/types/models.ts';

const api = new Proxy(
  {},
  { get: () => () => Promise.resolve({}) },
) as unknown as ApiClient;

/**
 * 构造一个最小的队列视图（Composer 只用 mode 决定文案）。
 * @param mode 聊天模式（默认插话）
 * @returns 队列视图桩
 */
function queueStub(mode: 'queue' | 'steer' = 'steer'): ChatQueueView {
  return {
    mode,
    items: [],
    paused: false,
    busy: true,
    onRemove: () => {},
    onPromote: () => {},
    onClear: () => {},
    onResume: () => {},
  };
}

test('busy 时发送：上抛 onSend（控制器按模式分流）并清空输入框', async () => {
  const calls: {
    prompt: string;
    images: { url?: string; data?: string; mediaType?: string }[];
    files: FileAttachment[];
  }[] = [];
  const ui = await renderFacadeAsync(Composer, {
    props: {
      model: 'mock',
      modelOptions: ['mock'],
      reasoning: 'medium',
      permission: 'auto',
      threadId: 's1',
      api,
      queue: queueStub(),
      onModelChange: () => {},
      onReasoningChange: () => {},
      onPermissionChange: () => {},
      onSend: (
        prompt: string,
        images: { url?: string; data?: string; mediaType?: string }[],
        files: FileAttachment[],
      ) => {
        calls.push({ prompt, images, files });
      },
      busy: true,
    },
  });
  const tree = facadeOf(ui.container.firstElementChild);
  const ta = byTag(tree, 'textarea')[0]?.el as HTMLTextAreaElement | undefined;
  assert.ok(ta !== undefined);
  ta.value = '改方向：先跑测试';
  fireEvent.input(ta, { target: { value: '改方向：先跑测试' } });
  const steer = byClass(tree, 'send')[0];
  assert.ok(steer !== undefined, 'busy 时应显示发送/插话按钮（send）');
  fireEvent.click(steer.el);
  await Promise.resolve();
  assert.deepStrictEqual(calls, [{ prompt: '改方向：先跑测试', images: [], files: [] }]);
  assert.strictEqual(ta.value, '');
});

test('busy + 队列模式：按钮语义是「加入队列」，Enter 同样上抛 onSend', async () => {
  const calls: string[] = [];
  const queue = queueStub('queue');
  const ui = await renderFacadeAsync(Composer, {
    props: {
      model: 'mock',
      modelOptions: ['mock'],
      reasoning: 'medium',
      permission: 'auto',
      threadId: 's1',
      api,
      queue,
      onModelChange: () => {},
      onReasoningChange: () => {},
      onPermissionChange: () => {},
      onSend: (prompt: string) => {
        calls.push(prompt);
      },
      busy: true,
    },
  });
  const tree = facadeOf(ui.container.firstElementChild);
  const ta = byTag(tree, 'textarea')[0]?.el as HTMLTextAreaElement | undefined;
  assert.ok(ta !== undefined);
  fireEvent.keyDown(ta, { key: 'Enter' });
  ta.value = '第二条任务';
  fireEvent.input(ta, { target: { value: '第二条任务' } });
  fireEvent.keyDown(ta, { key: 'Enter' });
  await Promise.resolve();
  assert.deepStrictEqual(calls, ['第二条任务']);
  const send = byClass(tree, 'send')[0];
  assert.strictEqual(send?.el.getAttribute('aria-label'), '加入队列');
});
