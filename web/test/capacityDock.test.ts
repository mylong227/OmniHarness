// 判据：左栏容量小图表（2026-10-28 用户指定的位置与交互）。
//
// 用户原话：「这里显示小的柱状图显示，进度，点击可以向上展开，再点就收起来看音频柱状动效」。
// 本判据钉住四件事：
//   ① 常驻收起态：一排音频柱 + 总占比，按钮可聚焦、aria-expanded 反映展开态；
//   ② 点击展开：向上弹出详情（上下文构成 + 今日余额），再点收起；
//   ③ 形状守卫：`context.usage` 回落成 `{}` 时不得抛错卸载（显示 —，仍可展开）；
//   ④ 数据真的来自 contextUsage / quotaGet。
//
// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderUi, waitFor } from './rtlHarness.ts';
import { CapacityDock } from '../src/ui/components/CapacityDock.tsx';

const USAGE = {
  threadId: 't-1',
  windowTokens: 128000,
  usedTokens: 39400,
  percent: 30.8,
  rows: [
    { key: 'system', label: '系统', tokens: 6200, percent: 15.7 },
    { key: 'user', label: '用户', tokens: 9400, percent: 23.9 },
    { key: 'assistant', label: '助手', tokens: 14800, percent: 37.6 },
    { key: 'tool', label: '工具', tokens: 7200, percent: 18.3 },
    { key: 'repo', label: '仓库索引', tokens: 1200, percent: 3.0 },
    { key: 'free', label: '空闲', tokens: 600, percent: 1.5 },
  ],
  mcpToolCount: 4,
  systemToolCount: 12,
  source: 'measured',
  cache: { promptTokens: 39400, cachedPromptTokens: 22700, calls: 12, hitRate: 0.576 },
  collectedAt: '2026-10-28T14:00:00.000Z',
};

const QUOTA = {
  plan: { id: 'plus', label: '升级', multiplier: 1.5, upgraded: true },
  dailyTokens: 1000000,
  effectiveTokens: 1500000,
  usedTokens: 39400,
  remainingPercent: 97.4,
  models: [{ name: 'deepseek-v4-flash', used: 39400, limit: 1500000, remainingPercent: 97.4 }],
  dayKey: '2026-10-28',
  resetAt: '2026-10-28T23:59:59.999+08:00',
  source: 'local-budget',
};

test('① 收起态：音频柱 + 占比；点击向上展开、再点收起', async () => {
  const ui = renderUi(CapacityDock, {
    responses: { contextUsage: USAGE, quotaGet: QUOTA },
  });
  await waitFor(() => {
    if (!(ui.container.textContent ?? '').includes('30.8%')) throw new Error('容量占比尚未渲染');
  });
  const dock = ui.container.querySelector('.cap-dock');
  assert.ok(dock !== null, '必须渲染收起态触发按钮');
  assert.strictEqual(dock.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(
    ui.container.querySelectorAll('.cap-eq-bar').length,
    6,
    '音频柱数量必须等于分类数（六类）',
  );

  // 展开：向上显示的详情（role=dialog），文案来自真实视图。
  fireEvent.click(dock);
  await waitFor(() => {
    if (ui.container.querySelector('.cap-dock-pop') === null) throw new Error('浮层未展开');
  });
  const pop = ui.container.querySelector('.cap-dock-pop');
  assert.ok(pop !== null);
  assert.match(pop.textContent ?? '', /上下文构成/);
  assert.match(pop.textContent ?? '', /今日余额/);
  assert.match(pop.textContent ?? '', /3\.9万\/12\.8万/);
  assert.strictEqual(dock.getAttribute('aria-expanded'), 'true');

  // 再点收起。
  fireEvent.click(dock);
  assert.strictEqual(ui.container.querySelector('.cap-dock-pop'), null, '再点必须收起');
  assert.strictEqual(dock.getAttribute('aria-expanded'), 'false');
});

test('② 形状守卫：context.usage 回落成 {} 时不抛错，占比显示 —', async () => {
  const ui = renderUi(CapacityDock, {
    responses: { contextUsage: {}, quotaGet: QUOTA },
  });
  await waitFor(() => {
    if (!(ui.container.textContent ?? '').includes('—')) throw new Error('降级态未渲染');
  });
  const dock = ui.container.querySelector('.cap-dock');
  assert.ok(dock !== null);
  fireEvent.click(dock);
  // 展开后也不得因为空报告抛错（无上下文段时给出"暂不可用"说明）。
  await waitFor(() => {
    if (ui.container.querySelector('.cap-dock-pop') === null) throw new Error('浮层未展开');
  });
  assert.match(ui.container.textContent ?? '', /容量数据暂不可用/);
});
