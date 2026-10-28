// 切会话时滚动状态复位的**接线守卫**（2026-10-28 前端审计中危）。
//
// ## 缺陷形态
//
// `StreamView` 的 `stickyRef`（是否贴底）与 `scrollTop`（虚拟窗口驱动）都是组件实例级状态，
// 只在挂载时初始化。典型症状：在会话 A 里上滚（stickyRef=false）后点开会话 B ⇒ B 停在 A 的
// 旧偏移，且因为 stickyRef 仍是 false，之后的新内容**再也不自动贴底**。同一文件对会话时钟
// 已显式按 `switched` 复位（`prevThreadForClockRef`），滚动这里此前漏了。
//
// ## 为什么是「接线」判据而不是行为判据
//
// 这条缺陷的观测点是**滚动位置**，而 jsdom 没有布局：`clientHeight` / `scrollHeight` 恒 0，
// `stickyScrollTop` 在任何实现下都返回 0——行为断言不会因代码坏掉而变红（假绿）。
// 故这里钉住接线契约：必须存在一个依赖 `threadId` 的 effect，且在 effect 里复位
// `stickyRef` 与 `scrollTop`。行为面由真机（`npm run smoke:ui`）覆盖。
//
// 直跑（web 测试统一入口）：npm run web:test
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../src/ui/components/StreamView.tsx', import.meta.url)),
  'utf8',
);

test('切会话必须复位贴底意图与滚动偏移（stickyRef / scrollTop / holeBoost）', () => {
  // 允许 effect 体内有注释与空行，用非贪婪跨行匹配到 `[threadId]` 依赖数组。
  const effect = /React\.useEffect\(\(\) => \{[\s\S]{0,400}?\}, \[threadId\]\);/u.exec(src);
  assert.ok(effect, '必须存在一个依赖 [threadId] 的复位 effect（否则切会话会带着旧滚动位置）');
  const body = effect[0];
  assert.match(body, /stickyRef\.current = true/u, '切会话必须重新贴底（否则新内容永不自动贴底）');
  assert.match(body, /setScrollTop\(0\)/u, '切会话必须把滚动偏移归零');
  assert.match(body, /setHoleBoost\(0\)/u, '切会话必须复位空洞加渲计数');
});
