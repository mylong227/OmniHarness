/**
 * repo-map 任务形状闸（`StepContextBuilder.shouldBuildRepoMap`）判据。
 *
 * 背景：2026-10-19 鹈鹕会话是「画 SVG 动画」，repo-map 却每步注入 ~1.5k token 的代码符号大纲，
 * 模型 6 次在 reasoning 里写「无关」。闸门刻意保守：只有「视觉/创作动词」且「无任何代码信号」
 * 时才跳过；误判代价只是少一份可选大纲，不会阻断工具。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StepContextBuilder } from '../../src/core/stepContextBuilder.ts';

test('纯视觉创作任务跳过 repo-map', () => {
  assert.strictEqual(
    StepContextBuilder.shouldBuildRepoMap(
      '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试',
    ),
    false,
    '「绘制/动画」且无真实代码信号 ⇒ 跳过',
  );
  assert.strictEqual(
    StepContextBuilder.shouldBuildRepoMap('画一张海报，配色温暖一点'),
    false,
    '海报/配色 ⇒ 跳过',
  );
});

test('代码任务照常注入 repo-map', () => {
  assert.strictEqual(
    StepContextBuilder.shouldBuildRepoMap('修复 src/app.ts 的报错'),
    true,
    '路径 + 扩展名 + 修复 ⇒ 注入',
  );
  assert.strictEqual(
    StepContextBuilder.shouldBuildRepoMap('画一个按钮组件并接入路由'),
    true,
    '「画」但含组件/路由 ⇒ 注入',
  );
  assert.strictEqual(
    StepContextBuilder.shouldBuildRepoMap('给动画播放器加一个调试开关'),
    true,
    '「动画」但含调试 ⇒ 注入',
  );
  assert.strictEqual(
    StepContextBuilder.shouldBuildRepoMap('创建一个HTML页面'),
    true,
    '不含视觉动词 ⇒ 保持历史行为',
  );
});
