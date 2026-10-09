// 状态栏「续跑」芯片的判据（2026-10-08 交互改进）。
//
// 为什么要这条判据：芯片是**降低学习成本**的主要手段——用户不必先学会「全部面板 → 编排」这套导航，
// 低头就能看见「有东西没跑完 + 一键续跑」。它必须满足三条：
//   ① 没有未完成的运行 ⇒ **不渲染任何节点**（不占位、不噪音）；
//   ② 有未完成运行时给出人话（含「跳过已完成 N 步」的悬停说明，回答「会不会整张图重跑」）；
//   ③ 点击把 (runId, name) 交给回调（实现只有一处：GraphController.resumeRun）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { GraphResumeChip } = await import('../dist/ui/components/GraphResumeChip.js');

/**
 * 渲染一次芯片（零 DOM 桩：函数组件直接调用）。
 * @param runs 运行态映射
 * @param onResume 续跑回调
 * @returns 渲染结果
 */
function render(runs, onResume = () => {}) {
  return runtime.render(GraphResumeChip, { runs, onResume });
}

test('没有未完成的运行 ⇒ 不渲染（不占位、不噪音）', () => {
  assert.strictEqual(render({}), null);
  assert.strictEqual(
    render({ r1: { runId: 'r1', defName: 'demo', done: false, nodes: [] } }),
    null,
    '运行中不算「未完成待续」',
  );
  assert.strictEqual(
    render({ r1: { runId: 'r1', defName: 'demo', done: true, ok: true, nodes: [] } }),
    null,
    '已成功不得出现续跑入口',
  );
});

test('有未完成的运行 ⇒ 出芯片、说明含步数、点击交给回调', () => {
  let clicked;
  // runId 用**系统真实形态**（时间前缀 ⇒ 字典序即时序），否则测的就不是产品实际行为。
  const node = render(
    {
      'wf-20261009T090909-aaaaaa': {
        runId: 'wf-20261009T090909-aaaaaa',
        defName: '旧运行',
        done: true,
        ok: false,
        nodes: [],
      },
      'wf-20261009T101010-bbbbbb': {
        runId: 'wf-20261009T101010-bbbbbb',
        defName: 'sample-research',
        done: true,
        ok: false,
        nodes: [
          { id: 'plan', status: 'done' },
          { id: 'a', status: 'done' },
          { id: 'b', status: 'blocked' },
        ],
      },
    },
    (runId, name) => {
      clicked = [runId, name];
    },
  );
  assert.ok(node !== null, '必须有芯片');
  assert.strictEqual(node.props.className, 'cs-item cs-resume');
  assert.match(String(node.props.title), /复用已完成 2 步的产出，只重跑剩下 1 步/);
  assert.ok(
    Array.isArray(node.children) && String(node.children[1] ?? '').includes('sample-research'),
    `芯片文案必须点名是哪个编排：${JSON.stringify(node.children)}`,
  );
  // 多个失败运行时取**最近**一条（时间前缀 ⇒ 字典序），否则用户会点到很久以前那次。
  node.props.onClick();
  assert.deepEqual(clicked, ['wf-20261009T101010-bbbbbb', 'sample-research']);
});
