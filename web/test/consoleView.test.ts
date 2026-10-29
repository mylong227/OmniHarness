// @vitest-environment jsdom
// 工作台控制台外壳：导航规模 / 焦点落点 / 选择条目 / 设置页与面板页的分派 / Esc 关闭。
//
// 这些行为是 2026-10-26 合并两个模态后新增的**唯一入口**逻辑：注册表本身有纯数据判据
// （consoleRegistry），这里补「接线」——左栏没有搜索框、点条目真的回调、面板内容真的注入。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as React from 'react';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { allText } from './domFacade.ts';

const { ConsoleView } = await import('../src/ui/components/console/ConsoleView.tsx');

/** 设置页上下文（与控制台入参同形）。 */
const SETTINGS = {
  theme: 'light' as const,
  themePref: 'light' as const,
  onThemePrefChange: () => {},
  locale: 'zh' as const,
  onLocaleChange: () => {},
  workspacePath: '/repo/demo',
  sessionScopeAll: false,
  onToggleSessionsScope: () => {},
  leftWidth: 248,
  rightWidth: 420,
  onLeftWidthChange: () => {},
  onRightWidthChange: () => {},
};

/**
 * 渲染控制台。
 * @param active 当前条目
 * @param picked 收集 onPick
 * @param closed 关闭回调计数
 * @returns 渲染结果
 */
async function renderConsole(active: string, picked: string[], closed: () => void) {
  return renderFacadeAsync(ConsoleView, {
    props: {
      open: true,
      active,
      onPick: (key: string) => picked.push(key),
      onClose: closed,
      workspacePath: '/repo/demo',
      connected: true,
      settings: SETTINGS,
      panelContent: React.createElement('div', { 'data-testid': 'panel-slot' }, '面板内容'),
    },
    responses: {
      getConfig: () => Promise.resolve({}),
      modelCatalog: () => Promise.resolve({ providers: [] }),
      listProfiles: () => Promise.resolve([]),
      getActiveProfile: () => Promise.resolve({ plugins: [] }),
    },
  });
}

test('控制台：左栏没有搜索框，打开时焦点落在当前导航项', async () => {
  // 2026-10-29：用户按截图要求删除「外观」页签（内容并入常规）⇒ 导航 24 → 23 项。
  const ui = await renderConsole('model', [], () => {});
  try {
    await waitFor(() => {
      if (ui.container.querySelectorAll('.sp-nav-item').length !== 23) {
        throw new Error('左导航没有渲染 23 项');
      }
    });
    assert.strictEqual(
      ui.container.querySelector('input[type="search"]'),
      null,
      '用户要求去掉搜索框：左栏不得再出现 search 输入',
    );
    const current = ui.container.querySelector('[data-pane="model"]');
    // 换 antd Menu 后这些仍是**组件自己**保证的契约（antd 只给 selectedKeys 的视觉态，
    // 不替你标 aria-current，也不替你写 title）。
    assert.strictEqual(current?.getAttribute('aria-current'), 'page', '当前项必须标 aria-current=page');
    assert.strictEqual(
      ui.container.querySelector('[data-pane="general"]')?.getAttribute('aria-current'),
      null,
      '非当前项不得标 aria-current',
    );
    assert.ok(
      (current?.getAttribute('title') ?? '') !== '',
      '条目必须保留原生 title（悬浮说明由现有提示层消费）',
    );
    // visualProbe 按 textContent 精确匹配条目文案（`.trim() === label`）：保持文案干净。
    assert.strictEqual(current?.textContent?.trim(), '模型与厂商', '条目文案必须与注册表 label 逐字一致');
    await waitFor(() => {
      const activeItem = ui.container.querySelector('[data-pane="model"]');
      if (activeItem === null || document.activeElement !== activeItem) {
        throw new Error('焦点没有落到当前导航项');
      }
    });
  } finally {
    ui.unmount();
  }
});

test('控制台：点设置条目与面板条目都走 onPick（同一个入口）', async () => {
  const picked: string[] = [];
  const ui = await renderConsole('governance', picked, () => {});
  try {
    // antd Menu 的条目是 `<li role="menuitem">`（不再是 button）：按 `data-pane` 定位，
    // 该属性同时是探针/几何判据的契约，比按文案找按钮更贴近要守的东西。
    const general = ui.container.querySelector('[data-pane="general"]');
    assert.ok(general !== null, '缺「常规」设置项');
    fireEvent.click(general);
    const plugins = ui.container.querySelector('[data-pane="plugins"]');
    assert.ok(plugins !== null, '缺「插件」面板项');
    fireEvent.click(plugins);
    assert.deepEqual(picked, ['general', 'plugins']);
    assert.match(allText(ui.node), /面板内容/, '面板条目必须把 panelContent 注入右侧');
  } finally {
    ui.unmount();
  }
});

test('控制台：设置条目渲染设置页，不渲染面板内容；Esc 关闭', async () => {
  let closed = 0;
  const ui = await renderConsole('general', [], () => {
    closed += 1;
  });
  try {
    await waitFor(() => {
      if (!ui.container.querySelector('.csl-settings')) throw new Error('设置页未渲染');
    });
    assert.strictEqual(
      ui.container.querySelector('[data-testid="panel-slot"]'),
      null,
      '设置页不得同时挂载面板内容',
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    assert.strictEqual(closed, 1, 'Esc 必须关闭控制台');
  } finally {
    ui.unmount();
  }
});
