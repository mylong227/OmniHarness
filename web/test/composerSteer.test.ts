// @vitest-environment jsdom
// A8：busy 时输入框发送 = 插话（turns.steer），不走 turns.run。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync } from './rtlHarness.ts';
import { byClass, byTag, facadeOf } from './domFacade.ts';
import { Composer } from '../src/ui/components/Composer.tsx';
import type { ApiClient } from '../src/core/ApiClient.ts';

test('busy 时点插话：调用 turns.steer 并清空输入框', async () => {
  const calls: { threadId: string; text: string }[] = [];
  const api = new Proxy(
    {
      steerTurn: async (threadId: string, text: string) => {
        calls.push({ threadId, text });
        return { ok: true, queued: true };
      },
    },
    { get: (obj, prop) => (prop in obj ? obj[prop as keyof typeof obj] : () => Promise.resolve({})) },
  ) as unknown as ApiClient;
  const ui = await renderFacadeAsync(Composer, {
    props: {
      model: 'mock',
      modelOptions: ['mock'],
      reasoning: 'medium',
      permission: 'auto',
      threadId: 's1',
      api,
      onModelChange: () => {},
      onReasoningChange: () => {},
      onPermissionChange: () => {},
      onSend: () => {
        throw new Error('busy 时不得走 onSend');
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
  assert.ok(steer !== undefined, 'busy 时应显示插话按钮（send）');
  fireEvent.click(steer.el);
  await Promise.resolve();
  assert.deepStrictEqual(calls, [{ threadId: 's1', text: '改方向：先跑测试' }]);
  assert.strictEqual(ta.value, '');
});
