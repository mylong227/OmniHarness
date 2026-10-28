// 「在途响应无序号」的竞态判据（2026-10-28 前端审计待办 ②）。
//
// ## 缺陷形态
//
// 三处列表都只防抖、不校验「响应回来时查询条件还是不是当前那个」：
//   · AddMenu 搜索：输入 `a` 后再改 `ab`（或删空），`a` 的慢响应晚到会把结果写回旧命中；
//   · ChangesTab 展开：点 A 立刻点 B，A 的 patch 后到会显示成 B 的内容；
//   · FilePicker 目录：在慢盘上点 B，A 的响应后到会把目录改回 A。
//
// ## 判据
//
// 用闸门（deferred）精确控制落地顺序，断言**旧响应被丢弃**：先发的最后落地，视图仍是后发的结果。
//
// 直跑（web 测试统一入口）：npm run web:test
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderUi } from './rtlHarness.ts';

const { AddMenu } = await import('../src/ui/components/AddMenu.tsx');

// FilePicker 的目录代际守卫是**防御性**的：切目录时列表会先被「读取中…」占位，
// UI 上点不出第二个目录，故这里没有可复现的 UI 竞态（守卫仍保留，防未来代码绕过 loading 门）。

/** 可手动兑现的 Promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 让 React 处理微任务与定时器回调（真实计时器，等防抖落地）。 */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await Promise.resolve();
  });
}

/** AddMenu 的搜索闸：按查询词记录每轮请求。 */
async function renderAddMenu() {
  const gates = new Map<string, ReturnType<typeof deferred<{ files: unknown[]; chats: unknown[] }>>>();
  const ui = renderUi(AddMenu, {
    props: {
      threadId: '',
      api: {
        modesGet: async () => ({ goal: '', planMode: false, sketchMode: false }),
        listPlugins: async () => [],
        agentsList: async () => ({ agents: [] }),
        searchAll: (q: string) => {
          const gate = deferred<{ files: unknown[]; chats: unknown[] }>();
          gates.set(q, gate);
          return gate.promise;
        },
      },
      onAttach: () => {},
      onToast: () => {},
      onOpenTab: () => {},
      onOpenFile: () => {},
      onLoadThread: () => {},
    },
  });
  await settle();
  fireEvent.keyDown(ui.root as HTMLElement, { key: 'Enter' });
  await settle();
  const input = ui.container.querySelector('.addmenu-input') as HTMLInputElement;
  return { ui, input, gates };
}

test('AddMenu 搜索：先发请求后到时不覆盖新关键字的结果', async () => {
  const { ui, input, gates } = await renderAddMenu();
  fireEvent.change(input, { target: { value: 'a' } });
  await settle(300); // 防抖到点 ⇒ 发出 searchAll('a')
  fireEvent.change(input, { target: { value: 'ab' } });
  await settle(300); // 防抖到点 ⇒ 发出 searchAll('ab')
  gates.get('ab')?.resolve({ files: [{ kind: 'file', id: 'ab', label: 'ab.txt', hint: '' }], chats: [] });
  await settle();
  assert.match(ui.container.textContent ?? '', /ab\.txt/u, '新查询结果必须显示');
  // 旧查询的响应此刻才到：必须被丢弃（否则列表会被 a 的结果覆盖）。
  gates.get('a')?.resolve({ files: [{ kind: 'file', id: 'a', label: 'a.txt', hint: '' }], chats: [] });
  await settle();
  assert.doesNotMatch(ui.container.textContent ?? '', /a\.txt/u, '旧关键字的结果不得写回');
});

test('AddMenu 搜索：删空关键字后，在途响应不得把结果重新填回来', async () => {
  const { ui, input, gates } = await renderAddMenu();
  fireEvent.change(input, { target: { value: 'a' } });
  await settle(300);
  fireEvent.change(input, { target: { value: '' } });
  await settle();
  gates.get('a')?.resolve({ files: [{ kind: 'file', id: 'late', label: 'late.txt', hint: '' }], chats: [] });
  await settle();
  assert.doesNotMatch(ui.container.textContent ?? '', /late\.txt/u, '清空后不得再出现旧命中');
});

