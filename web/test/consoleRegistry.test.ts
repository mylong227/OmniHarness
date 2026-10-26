// 工作台控制台注册表契约：设置分栏与功能面板**同一份导航**，不许漏项 / 重项。
//
// 为什么值得单测：控制台是设置与面板的唯一入口，导航清单一旦漏一项，用户就再也点不到
// 那一页（而且界面不会报错）。这里把"覆盖全集 / 无重复 / 分组稳定 / 默认落点"钉死。
import assert from 'node:assert/strict';
import { test } from 'vitest';

const {
  CONSOLE_ENTRIES,
  CONSOLE_GROUPS,
  CONSOLE_EXCLUDED_PANELS,
  DEFAULT_CONSOLE_ENTRY,
  consoleEntryOf,
  consoleEntriesOfGroup,
  isSettingKey,
  missingPanels,
} = await import('../src/ui/models/ConsoleRegistry.ts');
const { PANELS } = await import('../src/ui/models/PanelRegistry.ts');
const { SETTINGS_TABS } = await import('../src/ui/models/SettingsModel.ts');

test('每个设置分栏都恰好出现一次，且都以设置页身份出现', () => {
  for (const tab of SETTINGS_TABS) {
    const hits = CONSOLE_ENTRIES.filter((entry) => entry.key === tab.key);
    assert.strictEqual(hits.length, 1, `设置分栏 ${tab.key} 在控制台里出现了 ${String(hits.length)} 次`);
    assert.strictEqual(hits[0]?.kind, 'setting', `设置分栏 ${tab.key} 被当成了功能面板`);
  }
});

test('除「文件 / 权限」外，每个功能面板都进入控制台且只出现一次', () => {
  for (const panel of PANELS) {
    const hits = CONSOLE_ENTRIES.filter((entry) => entry.key === panel.key);
    if (CONSOLE_EXCLUDED_PANELS.includes(panel.key)) {
      // 被排除的只是「面板身份」：permission 同时是设置分栏，必须仍以 setting 身份出现。
      assert.ok(
        hits.every((entry) => entry.kind === 'setting'),
        `排除面板 ${panel.key} 若仍出现在控制台，必须是设置页而不是功能面板`,
      );
      continue;
    }
    assert.strictEqual(hits.length, 1, `功能面板 ${panel.key} 在控制台里出现了 ${String(hits.length)} 次`);
    assert.ok(panel.description !== '', `面板 ${panel.key} 缺 description（页面副标题会空）`);
  }
  assert.deepStrictEqual(missingPanels(), [], '有面板没被任何分组收录（也不会被显式排除）');
});

test('条目 key 全表唯一（设置 key 与面板 key 不撞车）', () => {
  const seen = new Set();
  for (const entry of CONSOLE_ENTRIES) {
    assert.ok(!seen.has(entry.key), `控制台条目 key 重复：${entry.key}`);
    seen.add(entry.key);
  }
});

test('分组顺序固定：基础设置 → Agent 能力 → 数据与统计，且每组都非空', () => {
  assert.deepEqual(CONSOLE_GROUPS.map((group) => group.label), ['基础设置', 'Agent 能力', '数据与统计']);
  for (const group of CONSOLE_GROUPS) {
    assert.ok(consoleEntriesOfGroup(group.key).length > 0, `分组 ${group.key} 为空`);
  }
});

test('默认落点是「常规」设置页（点设置按钮即可进入）', () => {
  assert.strictEqual(DEFAULT_CONSOLE_ENTRY, 'general');
  const entry = consoleEntryOf(DEFAULT_CONSOLE_ENTRY);
  assert.strictEqual(entry.kind, 'setting');
  assert.strictEqual(entry.label, '常规');
});

test('设置 key 判定只认 SETTINGS_TABS（避免把面板 key 误判成设置页）', () => {
  for (const tab of SETTINGS_TABS) assert.strictEqual(isSettingKey(tab.key), true, tab.key);
  assert.strictEqual(isSettingKey('plugins'), false);
  assert.strictEqual(isSettingKey('file'), false);
  assert.strictEqual(isSettingKey('bogus'), false);
});

test('未知 key 回退到默认条目（不抛错、不渲染空白页）', () => {
  assert.strictEqual(consoleEntryOf('bogus').key, DEFAULT_CONSOLE_ENTRY);
});
