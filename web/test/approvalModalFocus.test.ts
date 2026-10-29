// 审批弹窗焦点圈定判据（2026-10-28 前端审计中危）。
//
// ## 缺陷形态
//
// `ApprovalModal` 的 Tab 圈定只登记了「始终允许 / 拒绝 / 允许」三个按钮，漏掉 DOM 里紧随其后的
// 「更改权限」：从「允许」按 Tab 会直接回到「始终允许」，键盘用户**无论怎么 Tab 都到不了**
// 更改权限（鼠标可点，键盘不可达）。
//
// ## 判据
//
// 把焦点放到「允许」，按 Tab 一次 ⇒ 焦点必须落在「更改权限」；再按 Tab ⇒ 回到「始终允许」；
// 从「始终允许」按 Shift+Tab ⇒ 回到「更改权限」（反向也一样闭环）。
//
// 直跑（web 测试统一入口）：npm run web:test
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderUi, screen } from './rtlHarness.ts';

const { ApprovalModal } = await import('../src/ui/components/ApprovalModal.tsx');

/** 渲染一个带「更改权限」入口的待审批请求。 */
async function renderModal() {
  renderUi(ApprovalModal, {
    props: {
      approval: { requestId: 'r1', toolName: 'write_file', target: 'src/a.ts', args: { path: 'src/a.ts' } },
      onRespond: () => {},
      onChangePermission: () => {},
    },
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    // antd Modal 经 Portal 渲染到 document.body；键盘 trap 经 wrapProps 挂在包裹层（keyDown 从
    // dialog 冒泡上来）。antd 给两字按钮自动插空格（「允 许」），按 role+正则找而不是字面文本。
    dialog: screen.getByRole('dialog') as HTMLElement,
    allow: screen.getByRole('button', { name: /^允\s*许$/ }).closest('button') as HTMLButtonElement,
    always: screen.getByRole('button', { name: '始终允许' }).closest('button') as HTMLButtonElement,
    changePerm: screen
      .getByRole('button', { name: '更改权限' })
      .closest('button') as HTMLButtonElement,
  };
}

test('Tab 圈定必须包含「更改权限」：允许 → 更改权限 → 始终允许 正向闭环', async () => {
  const { dialog, allow, always, changePerm } = await renderModal();
  act(() => allow.focus());
  fireEvent.keyDown(dialog, { key: 'Tab' });
  assert.strictEqual(document.activeElement, changePerm, '「允许」之后必须是「更改权限」');
  fireEvent.keyDown(dialog, { key: 'Tab' });
  assert.strictEqual(document.activeElement, always, '「更改权限」之后回到「始终允许」');
});

test('Shift+Tab 反向同样闭环：始终允许 → 更改权限', async () => {
  const { dialog, always, changePerm } = await renderModal();
  act(() => always.focus());
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  assert.strictEqual(document.activeElement, changePerm, '反向必须也能到「更改权限」');
});
