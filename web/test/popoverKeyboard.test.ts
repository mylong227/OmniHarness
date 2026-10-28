// 弹层触发器与菜单项的**键盘可达性**判据（2026-10-28 前端审计高危第 4 条）。
//
// ## 缺陷形态
//
// 四个弹层触发器（模型 / 权限 / 添加 / 上下文容量）与它们的菜单项都是
// `div role="button"` / `div role="option"`：`role` 只影响读屏播报，**不给**原生 Enter/Space
// 激活、也不让元素进入 Tab 序列（没有 `tabIndex`）。结果：纯键盘用户打不开面板；即便用鼠标
// 打开，Tab 也跳不进菜单项、Enter 选不中任何一项。
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
const { ContextCapacityPanel } = await import('../src/ui/components/ContextCapacityPanel.tsx');
const { FilePicker } = await import('../src/ui/components/FilePicker.tsx');
const { ActivationKeys } = await import('../src/ui/models/ActivationKeys.ts');

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
  for (const item of items) {
    assert.strictEqual(item.getAttribute('tabindex'), '0', '菜单项必须可聚焦');
  }
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
  for (const item of items) assert.strictEqual(item.getAttribute('tabindex'), '0');
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

test('ContextCapacityPanel：触发器可聚焦，Enter 展开 / 再 Enter 收起', async () => {
  const ui = renderUi(ContextCapacityPanel, {
    props: {
      threadId: 't-1',
      api: {
        contextUsage: async () => ({
          threadId: 't-1',
          windowTokens: 1000,
          usedTokens: 10,
          percent: 1,
          rows: [],
          mcpToolCount: 0,
          systemToolCount: 0,
          source: 'measured',
          cache: { promptTokens: 0, cachedPromptTokens: 0, calls: 0, hitRate: 0 },
          collectedAt: '2026-10-18T00:00:00.000Z',
        }),
        quotaGet: async () => ({
          plan: { id: 'free', label: '免费', multiplier: 1, upgraded: false },
          dailyTokens: 1000,
          effectiveTokens: 1000,
          usedTokens: 10,
          remainingPercent: 99,
          models: [],
          dayKey: '2026-10-18',
          resetAt: '2026-10-19T00:00:00.000Z',
          source: 'local-budget',
        }),
      },
      onToast: () => {},
    },
  });
  await flush();
  const trigger = ui.root as HTMLElement;
  assert.strictEqual(trigger.getAttribute('tabindex'), '0');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await flush();
  assert.ok(ui.container.querySelector('.cap-pop') !== null, 'Enter 必须展开容量面板');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  assert.strictEqual(ui.container.querySelector('.cap-pop'), null, '再按 Enter 必须收起');
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false', '收起后 aria-expanded 必须回到 false');
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
  const modal = ui.container.querySelector('.fp-modal') as HTMLElement;
  assert.strictEqual(modal.getAttribute('role'), 'dialog', '文件选择器是模态：必须有 role=dialog');
  assert.strictEqual(modal.getAttribute('aria-modal'), 'true');
  assert.strictEqual(modal.getAttribute('aria-label'), '选择附件文件');
  assert.strictEqual(document.activeElement, modal, '打开时焦点必须进入弹窗（否则 Enter 仍发给背后输入框）');
  const file = ui.container.querySelector('.fp-file') as HTMLElement;
  assert.strictEqual(file.getAttribute('tabindex'), '0', '文件项必须可聚焦');
  assert.strictEqual(file.getAttribute('role'), 'checkbox');
  fireEvent.keyDown(file, { key: 'Enter' });
  assert.strictEqual(file.getAttribute('aria-checked'), 'true', 'Enter 必须勾选文件');
  assert.match(ui.container.querySelector('.fp-selected-count')?.textContent ?? '', /已选 1 个/u);
  fireEvent.click(screen.getByText('添加 1 个文件'));
  assert.strictEqual(picked.length, 1, '确认必须回传选中文件');
  assert.match(picked[0]![0]!, /a\.txt$/u);
});
