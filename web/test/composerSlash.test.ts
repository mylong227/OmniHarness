// @vitest-environment jsdom
// Composer `/` 技能选择器：输入 `/rev` 拉取技能、点击插入 `/review `。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { allText, byClass, byTag, facadeOf } from './domFacade.ts';
import { Composer } from '../src/ui/components/Composer.tsx';
import type { ApiClient } from '../src/core/ApiClient.ts';

/** 只实现 listSkills，其余 RPC 一律空成功。 */
function fakeApi(): ApiClient {
  const target = {
    listSkills: async () => ({
      skills: [
        { name: 'review', description: '代码审查', tags: ['git'] },
        { name: 'test', description: '运行测试', tags: [] },
      ],
    }),
  };
  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop in obj) return obj[prop as keyof typeof obj];
      return () => Promise.resolve({});
    },
  }) as unknown as ApiClient;
}

test('输入 / 显示技能候选，点击后插入技能名', async () => {
  const ui = await renderFacadeAsync(Composer, {
    props: {
      model: 'mock',
      modelOptions: ['mock'],
      reasoning: 'medium',
      permission: 'auto',
      api: fakeApi(),
      onModelChange: () => {},
      onReasoningChange: () => {},
      onPermissionChange: () => {},
      onSend: () => {},
    },
  });
  const tree = (): ReturnType<typeof facadeOf> => facadeOf(ui.container.firstElementChild);
  const ta = byTag(tree(), 'textarea')[0];
  assert.ok(ta !== undefined);
  const el = ta.el as HTMLTextAreaElement;
  el.value = '/rev';
  el.selectionStart = 4;
  el.selectionEnd = 4;
  fireEvent.input(el, { target: { value: '/rev' } });
  await waitFor(() => assert.strictEqual(byClass(tree(), 'mention-item').length, 1));
  const item = byClass(tree(), 'mention-item').find((n) => allText(n).includes('/review'));
  assert.ok(item !== undefined);
  fireEvent.mouseDown(item.el);
  assert.strictEqual(el.value, '/review ');
  assert.strictEqual(byClass(tree(), 'mention-item').length, 0);
});
