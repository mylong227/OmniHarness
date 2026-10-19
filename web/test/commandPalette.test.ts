// 命令面板组件契约（真实 React + jsdom）：
// 过滤 / 键盘选中 / Enter 执行 / Esc 关闭 / 空态 / 清除搜索 / combobox ARIA。
//
// 视觉由真机截图复核（web/test/visualProbe.ts --states=cmdk），这里只锁**交互契约**：
// 命令面板最容易回归的不是颜色，而是「上下键选中的到底是不是屏幕上那一行」。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderUi, screen } from './rtlHarness.ts';
import type { CommandItem } from '../src/ui/models/CommandPaletteModel.ts';

const { CommandPalette } = await import('../src/ui/components/CommandPalette.tsx');

const COMMANDS: CommandItem[] = [
  { id: 'pane-tools', label: '工具', group: '面板', run: () => {} },
  { id: 'pane-metrics', label: '指标', group: '面板', run: () => {} },
  { id: 'new-session', label: '新建会话', group: '会话', hint: 'Ctrl/Cmd+N', run: () => {} },
];

/**
 * 渲染打开态的命令面板。
 * @param commands 命令集
 * @param onClose 关闭回调
 * @returns 渲染结果
 */
function renderPalette(commands: CommandItem[], onClose: () => void) {
  return renderUi(CommandPalette, { props: { open: true, commands, onClose } });
}

test('关闭态不渲染任何节点', () => {
  const ui = renderUi(CommandPalette, { props: { open: false, commands: COMMANDS, onClose: () => {} } });
  assert.strictEqual(ui.container.firstElementChild, null);
});

test('打开态：combobox → listbox，首项即选中项', async () => {
  renderPalette(COMMANDS, () => {});
  const input = screen.getByRole('combobox');
  const dialog = screen.getByRole('dialog', { name: '命令面板' });
  assert.strictEqual(input.getAttribute('aria-expanded'), 'true');
  const listbox = screen.getByRole('listbox');
  assert.strictEqual(input.getAttribute('aria-controls'), listbox.id);
  const helpId = input.getAttribute('aria-describedby');
  assert.ok(helpId, 'combobox 必须有键盘说明的 aria-describedby');
  assert.match(document.getElementById(helpId)?.textContent ?? '', /↑↓/);
  const options = screen.getAllByRole('option');
  assert.strictEqual(options.length, 3);
  assert.strictEqual(options[0]!.getAttribute('aria-selected'), 'true');
  assert.strictEqual(input.getAttribute('aria-activedescendant'), options[0]!.id);
  assert.ok(dialog.contains(listbox));
  // 打开后下一帧聚焦搜索框（effect 里的 setTimeout 0）：只冲一次宏任务，不用 waitFor
  // 轮询——这条判据关心的是「有没有聚焦」，不是异步时序。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.strictEqual(document.activeElement, input);
});

test('↑↓ 移动选中项，aria-activedescendant 跟着换', () => {
  renderPalette(COMMANDS, () => {});
  const input = screen.getByRole('combobox');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  const options = screen.getAllByRole('option');
  assert.strictEqual(options[1]!.getAttribute('aria-selected'), 'true');
  assert.strictEqual(input.getAttribute('aria-activedescendant'), options[1]!.id);
  fireEvent.keyDown(input, { key: 'ArrowUp' });
  assert.strictEqual(screen.getAllByRole('option')[0]!.getAttribute('aria-selected'), 'true');
});

test('Enter 执行选中项，并先关闭面板', () => {
  let runs = 0;
  let closes = 0;
  const commands: CommandItem[] = COMMANDS.map((c, i) => ({ ...c, run: () => (runs = i + 1) }));
  renderPalette(commands, () => (closes += 1));
  const input = screen.getByRole('combobox');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  assert.strictEqual(closes, 1, '执行前必须先 onClose');
  assert.strictEqual(runs, 2, '执行的是第二项（指标）');
});

test('Esc 关闭面板', () => {
  let closes = 0;
  renderPalette(COMMANDS, () => (closes += 1));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  assert.strictEqual(closes, 1);
});

test('搜索过滤：命中片段包 mark；无匹配显示空态并撤掉 listbox', () => {
  renderPalette(COMMANDS, () => {});
  const input = screen.getByRole('combobox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '指标' } });
  const options = screen.getAllByRole('option');
  assert.strictEqual(options.length, 1);
  assert.strictEqual(options[0]!.textContent, '指标');
  assert.ok(options[0]!.querySelector('mark.cmdk-mark'), '命中的「指标」必须是 mark');
  fireEvent.change(input, { target: { value: '不存在的命令' } });
  assert.ok(screen.getByText('无匹配命令'));
  assert.strictEqual(screen.queryByRole('listbox'), null);
});

test('清除搜索：按钮把查询归零并恢复全部命令', () => {
  renderPalette(COMMANDS, () => {});
  const input = screen.getByRole('combobox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '指' } });
  const clear = screen.getByRole('button', { name: '清除搜索' });
  fireEvent.click(clear);
  assert.strictEqual(input.value, '');
  assert.strictEqual(screen.getAllByRole('option').length, 3);
});
