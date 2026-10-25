// 设置面板结构契约：字段声明（SETTINGS_FIELDS）与分栏声明（SETTINGS_TABS）的一致性。
//
// 为什么值得单测：设置面板的**单一事实源**是 `SettingsModel` 里的两份声明数组，
// 组件只是把它渲染出来。这带来一种新风险——声明本身可能自相矛盾（字段指向不存在的分栏、
// 两个字段抢同一个配置键、下拉没有取值域），而这种错在界面上表现为"某一项消失"或
// "改了这个却动到那个"，肉眼很难定位。这里把性质钉死。
//
// 直跑 web/dist，node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import { test } from 'vitest';

const { SETTINGS_FIELDS, SETTINGS_TABS, CATALOG_KEYS, SettingsModel } = await import(
  '../src/ui/models/SettingsModel.ts'
);

test('每个字段都归属一个已声明的分栏（不留孤儿字段）', () => {
  const keys = new Set(SETTINGS_TABS.map((t) => t.key));
  for (const f of SETTINGS_FIELDS) {
    assert.ok(keys.has(f.tab), `字段 ${String(f.key)} 指向未声明的分栏 ${f.tab}`);
  }
});

test('每个分栏要么有声明字段，要么是「自定义渲染」分栏（不留空分栏）', () => {
  // 两个分栏不由 SETTINGS_FIELDS 驱动，而是组件里手写渲染（它们不是"一行一个配置键"的形状）：
  //   appearance —— 主题是分段控件（两态），不是 select
  //   profiles   —— 配置集应用 + 生效插件回显，且依赖 profile.* 而非 config.*
  //   desktop    —— 桌面桥（托盘/开机启动/更新），浏览器下只显示说明
  // 这里显式列出它们，避免"某个分栏因为忘了声明字段而空着"被一并豁免掉。
  const CUSTOM_RENDERED = new Set(['appearance', 'profiles', 'desktop']);
  for (const t of SETTINGS_TABS) {
    const n = SETTINGS_FIELDS.filter((f) => f.tab === t.key).length;
    if (CUSTOM_RENDERED.has(t.key)) continue;
    assert.ok(n > 0, `分栏「${t.label}」(${t.key}) 没有任何可设置项，且未登记为自定义渲染`);
  }
});

test('同一个配置键只出现在一个字段里（否则两处编辑会互相覆盖）', () => {
  const seen = new Map();
  for (const f of SETTINGS_FIELDS) {
    const k = String(f.key);
    assert.ok(!seen.has(k), `配置键 ${k} 被声明了两次（字段会互相打架）`);
    seen.set(k, f);
  }
});

test('下拉字段必须给出取值域，且当前值域非空', () => {
  for (const f of SETTINGS_FIELDS) {
    if (f.kind !== 'select') continue;
    assert.ok(Array.isArray(f.options) && f.options.length > 0, `下拉字段 ${String(f.key)} 缺 options`);
  }
});

test('文本字段必须给 placeholder 或 hint 之一（不留"不知道填什么"的空框）', () => {
  for (const f of SETTINGS_FIELDS) {
    if (f.kind !== 'text') continue;
    assert.ok(
      (f.placeholder !== undefined && f.placeholder !== '') || (f.hint !== undefined && f.hint !== ''),
      `文本字段 ${String(f.key)} 既无 placeholder 也无 hint`,
    );
  }
});

test('CATALOG_KEYS 只包含真实存在的字段键（防写错键名导致"该刷的不刷"）', () => {
  const declared = new Set(SETTINGS_FIELDS.map((f) => String(f.key)));
  for (const k of CATALOG_KEYS) {
    assert.ok(declared.has(k), `CATALOG_KEYS 里的 ${k} 不是任何字段的 key`);
  }
});

test('分栏 key 唯一且按「模型 → 运行时 → 权限 → 外观 → 配置集 → 桌面」排序', () => {
  assert.deepEqual(SETTINGS_TABS.map((t) => t.key), [
    'model',
    'runtime',
    'permission',
    'appearance',
    'profiles',
    'desktop',
  ]);
});

test('每个分栏都有 hint（模态里用 title 提示这一栏管什么）', () => {
  for (const t of SETTINGS_TABS) {
    assert.ok(typeof t.hint === 'string' && t.hint !== '', `分栏 ${t.key} 缺 hint`);
  }
});

test('valueOf 对未加载快照返回空串（不在 UI 上抛出 undefined）', () => {
  const model = new SettingsModel({
    getConfig: async () => ({}),
    updateConfig: async () => ({}),
    listProfiles: async () => [],
    getActiveProfile: async () => ({}),
    applyProfile: async () => ({}),
    toast: () => {},
  });
  for (const f of SETTINGS_FIELDS) {
    assert.strictEqual(model.valueOf(f.key), '', `未加载时 ${String(f.key)} 应为空串`);
  }
  assert.strictEqual(model.boolOf('autoApprove'), false, '未加载时开关应为 false');
  model.dispose();
});
