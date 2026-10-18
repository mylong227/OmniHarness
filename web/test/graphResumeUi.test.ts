// 「编排」面板的**续跑入口**判据（2026-10-08）。
//
// 契约（2026-10-08 交互改进后）：组件**不再自己发 RPC**——续跑实现只有一处
// （`GraphController.resumeRun`，状态栏芯片也用同一实现），组件通过 `onResume` 上抛。
// 本判据钉三件事：
//   ① 只有「已结束且未成功」的运行才出现按钮（运行中/已成功显示了只会误导）；
//   ② 点击把 (runId, name) 交给 `onResume`（控制器负责乐观复位、失败复原与提示）；
//   ③ 文案自己说清「跳过已完成 N 步」——用户最担心的就是「会不会整张图重跑一遍」。
//
// 迁移（2026-10-18）：旧用例手工递归展开函数组件节点。真实 React 会自己渲染子组件，
// 点击改为 `fireEvent.click`；`GraphTab` 挂载时的 `listGraphs` 用 responses 提供。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync } from './rtlHarness.ts';
import { allText, byClass } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';

const { GraphTab } = await import('../src/ui/components/tabs/GraphTab.tsx');

/**
 * 渲染一次 GraphTab。
 * @param runs 运行态映射
 * @returns 外观节点与调用记录
 */
async function mount(runs: Record<string, unknown>) {
  const calls = {
    resume: [] as [string, string][],
    runStart: [] as [string, string][],
  };
  const ui = await renderFacadeAsync(GraphTab, {
    props: {
      graphRuns: runs,
      onRunStart: (runId: string, name: string) => calls.runStart.push([runId, name]),
      onResume: (runId: string, name: string) => calls.resume.push([runId, name]),
    },
    responses: { listGraphs: [] },
  });
  return { tree: ui.node, calls };
}

/** 取续跑按钮（无则 undefined）。 */
function resumeButton(tree: Facade): FacadeNode | undefined {
  return byClass(tree, 'btn-resume')[0];
}

test('运行未结束 / 已成功时**不**显示续跑按钮（显示了只会误导）', async () => {
  const running = await mount({ r1: { runId: 'r1', defName: 'demo', done: false, nodes: [] } });
  assert.strictEqual(resumeButton(running.tree), undefined);

  const passed = await mount({ r2: { runId: 'r2', defName: 'demo', done: true, ok: true, nodes: [] } });
  assert.strictEqual(resumeButton(passed.tree), undefined);
});

test('已结束但未成功 ⇒ 按钮出现、文案自解释、点击交给 onResume', async () => {
  const { tree, calls } = await mount({
    run_x_1: {
      runId: 'run_x_1',
      defName: 'sample-research',
      done: true,
      ok: false,
      nodes: [
        { id: 'plan', status: 'done' },
        { id: 'a', status: 'done' },
        { id: 'b', status: 'blocked' },
      ],
    },
  });
  const btn = resumeButton(tree);
  assert.ok(btn !== undefined, '存在失败/被阻塞步骤的运行必须给出续跑入口');
  assert.strictEqual(allText(btn), '续跑（跳过已完成 2 步）', '文案必须自解释会跳过几步');
  assert.match(String(btn.props.title), /复用已完成 2 步的产出，只重跑剩下 1 步/);

  fireEvent.click(btn.el);
  assert.deepStrictEqual(calls.resume, [['run_x_1', 'sample-research']], '必须把 runId 与名字交给控制器');
  assert.deepStrictEqual(calls.runStart, [], '组件不再自己复位状态（避免与控制器两套实现漂移）');
});

test('节点列表为空（还没收到任何 progress）⇒ 退化为朴素文案，不编造步数', async () => {
  const { tree } = await mount({
    run_y_1: { runId: 'run_y_1', defName: 'demo', done: true, ok: false, nodes: [] },
  });
  const btn = resumeButton(tree);
  assert.ok(btn !== undefined);
  assert.strictEqual(allText(btn), '续跑', '没有节点数据时不得显示「跳过已完成 0 步」这类误导文案');
});
