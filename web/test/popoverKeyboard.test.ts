// 弹层触发器与菜单项的**键盘可达性**判据（2026-10-28 前端审计高危第 4 条）。
//
// ## 缺陷形态
//
// 弹层触发器（模型 / 权限 / 添加）与它们的菜单项都是
// `div role="button"` / `div role="option"`：`role` 只影响读屏播报，**不给**原生 Enter/Space
// 激活、也不让元素进入 Tab 序列（没有 `tabIndex`）。结果：纯键盘用户打不开面板；即便用鼠标
// 打开，Tab 也跳不进菜单项、Enter 选不中任何一项。
//
// 2026-10-28：上下文容量从输入区弹层移入控制台页面，这里不再有它的触发器。
//
// ## 判据
//
// ① 每个触发器可聚焦（`tabIndex === '0'`），Enter 能展开对应弹层；
// ② 展开后菜单项可聚焦，Enter 能选中（回调被调用且弹层收起）；
// ③ AddMenu 的关闭项（disabled）不得进入 Tab 序列（tabIndex=-1）且 Enter 不触发。
//
// 直跑（web 测试统一入口）：npm run web:test
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderUi, screen } from './rtlHarness.ts';

const { ModelPicker } = await import('../src/ui/components/ModelPicker.tsx');
const { PermissionPicker } = await import('../src/ui/components/PermissionPicker.tsx');
const { AddMenu } = await import('../src/ui/components/AddMenu.tsx');
const { FilePicker } = await import('../src/ui/components/FilePicker.tsx');
const { FolderPicker } = await import('../src/ui/components/FolderPicker.tsx');
const { ActivationKeys } = await import('../src/ui/models/ActivationKeys.ts');
const { MenuFocusModel } = await import('../src/ui/models/MenuFocusModel.ts');

/** act 冲一次微任务（弹层内部会真的发 RPC，Promise.resolve 落地后才有数据）。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

test('ActivationKeys：只认 Enter / Space（含旧 Spacebar），并统一 preventDefault', () => {
  for (const key of ['Enter', ' ', 'Spacebar']) {
    let prevented = false;
    let fired = 0;
    const hit = ActivationKeys.activate(
      {
        key,
        preventDefault: () => {
          prevented = true;
        },
      },
      () => {
        fired += 1;
      },
    );
    assert.strictEqual(hit, true, `${key} 必须触发激活`);
    assert.strictEqual(prevented, true, `${key} 必须 preventDefault（Space 不得滚页）`);
    assert.strictEqual(fired, 1);
  }
  let fired = 0;
  const miss = ActivationKeys.activate({ key: 'a', preventDefault: () => {} }, () => {
    fired += 1;
  });
  assert.strictEqual(miss, false, '普通字符不得触发激活');
  assert.strictEqual(fired, 0);
});

test('ModelPicker：触发器可聚焦，Enter 展开，菜单项 Enter 选中', async () => {
  const picked: string[] = [];
  const ui = renderUi(ModelPicker, {
    props: {
      model: 'm1',
      modelOptions: ['m1', 'm2'],
      reasoning: '',
      reasoningOptions: [],
      onModelChange: (m: string) => picked.push(m),
      onReasoningChange: () => {},
    },
  });
  await flush();
  const trigger = ui.root as HTMLElement;
  assert.strictEqual(trigger.getAttribute('tabindex'), '0', '触发器必须进 Tab 序列');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const items = [...ui.container.querySelectorAll('.mp-item')] as HTMLElement[];
  assert.strictEqual(items.length, 2, 'Enter 必须展开模型清单');
  // roving tabindex（WAI-ARIA 菜单）：整个菜单只保留一个 Tab 落点，其余靠方向键。
  assert.deepStrictEqual(
    items.map((el) => el.getAttribute('tabindex')),
    ['0', '-1'],
    '菜单必须只有一个 Tab 落点',
  );
  fireEvent.keyDown(items[1]!, { key: 'Enter' });
  assert.deepStrictEqual(picked, ['m2'], '菜单项 Enter 必须选中');
  assert.strictEqual(ui.container.querySelector('.mp-menu'), null, '选中后必须收起');
});

test('PermissionPicker：触发器可聚焦，Enter 展开，档位项 Enter 选中', async () => {
  const picked: string[] = [];
  const ui = renderUi(PermissionPicker, {
    props: {
      permission: 'ask',
      onPick: (v: string) => picked.push(v),
      api: { approvalTiers: async () => ({ tiers: [] }) },
    },
  });
  await flush();
  const trigger = ui.root as HTMLElement;
  assert.strictEqual(trigger.getAttribute('tabindex'), '0');
  fireEvent.keyDown(trigger, { key: ' ' });
  const items = [...ui.container.querySelectorAll('.dd-item')] as HTMLElement[];
  assert.ok(items.length > 0, 'Space 必须展开档位清单');
  assert.strictEqual(
    items.filter((el) => el.getAttribute('tabindex') === '0').length,
    1,
    'roving tabindex：只有一个 Tab 落点',
  );
  fireEvent.keyDown(items[0]!, { key: 'Enter' });
  assert.strictEqual(picked.length, 1, '档位项 Enter 必须选中');
  assert.strictEqual(ui.container.querySelector('.dd-menu'), null, '选中后必须收起');
});

test('AddMenu：Enter 展开菜单，首项 Enter 触发附加（onAttach）', async () => {
  const calls: string[] = [];
  const ui = renderUi(AddMenu, {
    props: {
      threadId: '',
      api: {
        modesGet: async () => ({ goal: '', planMode: false, sketchMode: false }),
        listPlugins: async () => [],
        agentsList: async () => ({ agents: [] }),
        searchAll: async () => ({ files: [], chats: [] }),
      },
      onAttach: () => calls.push('attach'),
      onToast: () => {},
      onOpenTab: () => {},
      onOpenFile: () => {},
      onLoadThread: () => {},
    },
  });
  await flush();
  const trigger = ui.root as HTMLElement;
  assert.strictEqual(trigger.getAttribute('tabindex'), '0');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await flush();
  const items = [...ui.container.querySelectorAll('.addmenu-item')] as HTMLElement[];
  assert.ok(items.length > 0, 'Enter 必须展开菜单（含至少一个可用项）');
  const enabled = items.filter((item) => item.getAttribute('aria-disabled') !== 'true');
  assert.ok(enabled.length > 0, '至少要有可用项');
  assert.strictEqual(enabled[0]!.getAttribute('tabindex'), '0', '可用项必须可聚焦');
  const disabled = items.find((item) => item.getAttribute('aria-disabled') === 'true');
  if (disabled !== undefined) {
    assert.strictEqual(disabled.getAttribute('tabindex'), '-1', '禁用项不得进入 Tab 序列');
  }
  fireEvent.keyDown(enabled[0]!, { key: 'Enter' });
  assert.deepStrictEqual(calls, ['attach'], '首项 Enter 必须触发附加');
});

test('FilePicker：模态语义齐全，焦点进入弹窗，列表项可聚焦并用 Enter 勾选', async () => {
  const picked: string[][] = [];
  const ui = renderUi(FilePicker, {
    props: {
      api: {
        browseFs: async () => ({
          level: 'dir',
          path: 'C:/w',
          dirs: ['sub'],
          files: [{ name: 'a.txt', mediaType: 'text/plain', size: 10 }],
          parent: 'C:/',
        }),
      },
      onCancel: () => {},
      onPick: (files: string[]) => picked.push(files),
    },
  });
  await flush();
  // 2026-10-29：选择器浮层换 antd Modal（portal 到 body）⇒ 从 document 查；
  // 聚焦由壳在「下一帧」补（antd 要等 transition，jsdom 永远等不到）⇒ 再等一个宏任务。
  await nextTick();
  const modal = document.querySelector('.fp-modal') as HTMLElement;
  assert.strictEqual(modal.getAttribute('role'), 'dialog', '文件选择器是模态：必须有 role=dialog');
  assert.strictEqual(modal.getAttribute('aria-modal'), 'true');
  assert.strictEqual(modal.getAttribute('aria-label'), '选择附件文件');
  assert.strictEqual(document.activeElement, modal, '打开时焦点必须进入弹窗（否则 Enter 仍发给背后输入框）');
  const file = document.querySelector('.fp-file') as HTMLElement;
  assert.strictEqual(file.getAttribute('tabindex'), '0', '文件项必须可聚焦');
  assert.strictEqual(file.getAttribute('role'), 'checkbox');
  fireEvent.keyDown(file, { key: 'Enter' });
  assert.strictEqual(file.getAttribute('aria-checked'), 'true', 'Enter 必须勾选文件');
  assert.match(document.querySelector('.fp-selected-count')?.textContent ?? '', /已选 1 个/u);
  fireEvent.click(screen.getByText('添加 1 个文件'));
  assert.strictEqual(picked.length, 1, '确认必须回传选中文件');
  assert.match(picked[0]![0]!, /a\.txt$/u);
  // portal 渲染的 Modal 不会随 render 容器自动清理：显式卸载，避免污染后续用例。
  ui.unmount();
});

// ---- WAI-ARIA 菜单交互：roving tabindex + 方向键（2026-10-28 批②）----

/** 等一次宏任务（弹层展开后的「下一帧聚焦」走 setTimeout(0)）。 */
async function nextTick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

test('MenuFocusModel：环绕步进与 roving tabindex 的纯数学', () => {
  assert.strictEqual(MenuFocusModel.resolve('ArrowDown'), 'next');
  assert.strictEqual(MenuFocusModel.resolve('ArrowUp'), 'prev');
  assert.strictEqual(MenuFocusModel.resolve('Home'), 'first');
  assert.strictEqual(MenuFocusModel.resolve('End'), 'last');
  assert.strictEqual(MenuFocusModel.resolve('a'), null);
  assert.strictEqual(MenuFocusModel.step(0, 3, false), 1);
  assert.strictEqual(MenuFocusModel.step(2, 3, false), 0, '末项向下必须环绕到首项');
  assert.strictEqual(MenuFocusModel.step(0, 3, true), 2, '首项向上必须环绕到末项');
  assert.strictEqual(MenuFocusModel.step(-1, 3, true), 2);
  assert.strictEqual(MenuFocusModel.step(0, 0, false), -1, '空列表无落点');
  assert.strictEqual(MenuFocusModel.edge(3, 'first'), 0);
  assert.strictEqual(MenuFocusModel.edge(3, 'last'), 2);
  assert.strictEqual(MenuFocusModel.edge(0, 'last'), -1);
  assert.strictEqual(MenuFocusModel.tabIndexFor(1, 1), 0);
  assert.strictEqual(MenuFocusModel.tabIndexFor(0, 1), -1, 'roving：非活动项必须退出 Tab 序列');
});

test('ModelPicker：↑/↓/Home/End 移动焦点（环绕），Esc 收起并归还焦点', async () => {
  const ui = renderUi(ModelPicker, {
    props: {
      model: 'm1',
      modelOptions: ['m1', 'm2', 'm3'],
      reasoning: '',
      reasoningOptions: [],
      onModelChange: () => {},
      onReasoningChange: () => {},
    },
  });
  await flush();
  const trigger = ui.root as HTMLElement;
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const items = [...ui.container.querySelectorAll<HTMLElement>('.mp-item')];
  assert.strictEqual(items.length, 3);
  // roving tabindex：只有一个落点。
  assert.deepStrictEqual(
    items.map((el) => el.getAttribute('tabindex')),
    ['0', '-1', '-1'],
    '只有活动项在 Tab 序列里',
  );
  fireEvent.keyDown(ui.container.querySelector('.mp-menu') as HTMLElement, { key: 'ArrowDown' });
  assert.strictEqual(document.activeElement, items[1], '↓ 必须移到下一项');
  fireEvent.keyDown(items[1]!, { key: 'End' });
  assert.strictEqual(document.activeElement, items[2], 'End 必须跳到末项');
  fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
  assert.strictEqual(document.activeElement, items[0], '末项 ↓ 必须环绕到首项');
  fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
  assert.strictEqual(document.activeElement, items[2], '首项 ↑ 必须环绕到末项');
  fireEvent.keyDown(items[2]!, { key: 'Escape' });
  assert.strictEqual(ui.container.querySelector('.mp-menu'), null, 'Esc 必须收起菜单');
  assert.strictEqual(document.activeElement, trigger, 'Esc 必须把焦点还给触发器');
});

test('PermissionPicker：↓/↑ 在档位间移动，roving tabindex 只有一个落点', async () => {
  const ui = renderUi(PermissionPicker, {
    props: { permission: 'ask', onPick: () => {}, api: { approvalTiers: async () => ({ tiers: [] }) } },
  });
  await flush();
  fireEvent.keyDown(ui.root as HTMLElement, { key: 'Enter' });
  const items = [...ui.container.querySelectorAll<HTMLElement>('.dd-item')];
  assert.ok(items.length >= 2);
  assert.strictEqual(items.filter((el) => el.getAttribute('tabindex') === '0').length, 1);
  fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
  assert.strictEqual(document.activeElement, items[1]);
  fireEvent.keyDown(items[1]!, { key: 'ArrowUp' });
  assert.strictEqual(document.activeElement, items[0]);
});

test('AddMenu：↓ 从触发器进入首项、↑ 环绕到末项，禁用项不参与导航', async () => {
  const ui = renderUi(AddMenu, {
    props: {
      threadId: '',
      api: {
        modesGet: async () => ({ goal: '', planMode: false, sketchMode: false }),
        listPlugins: async () => [],
        agentsList: async () => ({ agents: [] }),
        searchAll: async () => ({ files: [], chats: [] }),
      },
      onAttach: () => {},
      onToast: () => {},
      onOpenTab: () => {},
      onOpenFile: () => {},
      onLoadThread: () => {},
    },
  });
  await flush();
  const trigger = ui.root as HTMLElement;
  // ↓ 直接展开并落到首项（不必先 Enter）。
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  await nextTick();
  const items = [...ui.container.querySelectorAll<HTMLElement>('[data-menu-item]')];
  assert.ok(items.length > 0, '菜单必须展开并产生可导航项');
  assert.strictEqual(document.activeElement, items[0], '↓ 必须落到首项');
  assert.strictEqual(items.filter((el) => el.getAttribute('tabindex') === '0').length, 1);
  fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
  assert.strictEqual(document.activeElement, items[items.length - 1], '首项 ↑ 必须环绕到末项');
  const disabled = [...ui.container.querySelectorAll<HTMLElement>('.addmenu-item[aria-disabled="true"]')];
  for (const el of disabled) {
    assert.strictEqual(el.getAttribute('tabindex'), '-1', '禁用项不得进入 Tab 序列');
    assert.strictEqual(el.hasAttribute('data-menu-item'), false, '禁用项不得参与方向键导航');
  }
});

// ---- 模态焦点陷阱 + 归还 opener（2026-10-28 批③）----

test('FilePicker：Tab 被陷阱接管（焦点不出弹窗），卸载后焦点归还 opener', async () => {
  const opener = document.createElement('button');
  opener.textContent = '打开选择器';
  document.body.append(opener);
  opener.focus();
  try {
    const ui = renderUi(FilePicker, {
      props: {
        api: { browseFs: async () => ({ level: 'dir', path: 'C:/w', dirs: [], files: [], parent: 'C:/' }) },
        onCancel: () => {},
        onPick: () => {},
      },
    });
    await flush();
    await nextTick();
    // 2026-10-29：选择器浮层换 antd Modal（portal 到 body）⇒ 从 document 查，不在 render 容器里。
    const modal = document.querySelector('.fp-modal') as HTMLElement;
    assert.strictEqual(document.activeElement, modal, '打开时焦点进入弹窗');
    fireEvent.keyDown(modal, { key: 'Tab' });
    assert.ok(
      modal.contains(document.activeElement),
      'Tab 必须被焦点陷阱接管（焦点不得跑到弹窗外的背后输入框）',
    );
    ui.unmount();
    assert.strictEqual(document.activeElement, opener, '卸载后必须把焦点还给打开它的控件');
  } finally {
    opener.remove();
  }
});

test('FolderPicker：Tab 被陷阱接管，卸载后焦点归还 opener', async () => {
  const opener = document.createElement('button');
  opener.textContent = '选择项目';
  document.body.append(opener);
  opener.focus();
  try {
    const ui = renderUi(FolderPicker, {
      props: {
        api: { browseFs: async () => ({ level: 'dir', path: 'C:/w', dirs: [], files: [], parent: 'C:/' }) },
        onCancel: () => {},
        onPick: () => {},
      },
    });
    await flush();
    await nextTick();
    // 2026-10-29：选择器浮层换 antd Modal（portal 到 body）⇒ 从 document 查，不在 render 容器里。
    const modal = document.querySelector('.fp-modal') as HTMLElement;
    assert.strictEqual(document.activeElement, modal);
    fireEvent.keyDown(modal, { key: 'Tab' });
    assert.ok(modal.contains(document.activeElement), 'Tab 必须被焦点陷阱接管');
    ui.unmount();
    assert.strictEqual(document.activeElement, opener, '卸载后必须归还焦点');
  } finally {
    opener.remove();
  }
});

