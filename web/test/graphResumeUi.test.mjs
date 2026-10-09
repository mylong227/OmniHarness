// 「编排」面板的**续跑入口**判据（2026-10-08）。
//
// 背景：`graph.resume` RPC（服务端复用已完成步骤、只重跑未完成的部分）与客户端方法
// `ApiClient.resumeGraph` 都已就位，但 UI 里**没有任何调用点** —— 用户在 Web 上跑坏了只能重跑整张图。
// 本判据钉住三件事：
//   ① 只有「已结束且未成功」的运行才出现续跑按钮（运行中/已成功显示了只会误导）；
//   ② 点击后真的发出 `graph.resume(runId)`，并用服务端返回的 runId 走既有 `onRunStart` 复位通道；
//   ③ 失败必须如实 toast（不许静默吞掉），且按钮在请求在途时禁用（防重复提交 ——
//      服务端对同一 runId 的在飞续跑是 fail-closed 拒绝的，见 tests/unit/graphRunRegistry.test.ts）。
//
// 手法与 mount.test.mjs / questionCard.test.mjs 一致：零 DOM 桩 + hooksStub 的 hook 槽位运行时。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { GraphTab } = await import('../dist/ui/components/tabs/GraphTab.js');

/**
 * 递归展开函数组件节点（零 DOM 环境里 createElement 不会实例化子组件）。
 * @param vnode 节点
 * @returns 展开后的节点树
 */
function expand(vnode) {
  if (vnode == null || typeof vnode !== 'object') return vnode;
  if (typeof vnode.type === 'function') return expand(vnode.type(vnode.props));
  return { ...vnode, children: (vnode.children ?? []).flat(Infinity).map(expand) };
}

/**
 * 深度收集元素节点。
 * @param vnode 节点
 * @returns 元素节点数组
 */
function walk(vnode) {
  if (vnode == null || typeof vnode !== 'object') return [];
  return [vnode, ...(vnode.children ?? []).flat(Infinity).flatMap(walk)];
}

/**
 * 取节点 className。
 * @param vnode 节点
 * @returns className（非字符串时为空串）
 */
function clsOf(vnode) {
  return typeof vnode?.props?.className === 'string' ? vnode.props.className : '';
}

/**
 * 收集子树里的全部文本（用于断言按钮文案）。
 * @param vnode 节点
 * @returns 文本数组
 */
function textsOf(vnode) {
  if (vnode == null) return [];
  if (typeof vnode === 'string' || typeof vnode === 'number') return [String(vnode)];
  if (typeof vnode !== 'object') return [];
  return (vnode.children ?? []).flat(Infinity).flatMap(textsOf);
}

/**
 * 渲染一次 GraphTab（注入可观测的 api/toast）。
 * @param runs 运行态映射
 * @param overrides api 覆写（resumeGraph 等）与 toast 捕获
 * @returns 渲染结果与记录容器
 */
function mount(runs, overrides = {}) {
  const calls = { resume: [], runStart: [], toasts: [] };
  runtime.appContext.api = {
    ...runtime.appContext.api,
    listGraphs: async () => [],
    resumeGraph: async (runId) => {
      calls.resume.push(runId);
      return overrides.resumeResult ?? { runId, nodeCount: 1 };
    },
  };
  runtime.appContext.toast = (message, kind) => calls.toasts.push([message, kind]);
  const tree = expand(
    runtime.render(GraphTab, {
      graphRuns: runs,
      onRunStart: (runId, name) => calls.runStart.push([runId, name]),
    }),
  );
  return { tree, calls };
}

/**
 * 在渲染树里找续跑按钮。
 * @param tree 展开后的树
 * @returns 按钮节点（未找到为 undefined）
 */
function resumeButtonOf(tree) {
  return walk(tree).find((n) => clsOf(n).includes('btn-resume'));
}

test('运行未结束 / 已成功时**不**显示续跑按钮（显示了只会误导）', () => {
  const running = mount({ r1: { runId: 'r1', defName: 'demo', done: false, nodes: [] } });
  assert.equal(resumeButtonOf(running.tree), undefined, '运行中不得出现续跑按钮');

  const passed = mount({ r2: { runId: 'r2', defName: 'demo', done: true, ok: true, nodes: [] } });
  assert.equal(resumeButtonOf(passed.tree), undefined, '已成功的运行不得出现续跑按钮');
});

test('已结束但未成功 ⇒ 出现续跑按钮；点击后发 graph.resume 并以同一 runId 复位运行态', async () => {
  const failed = { runId: 'run_x_1', defName: 'sample-research', done: true, ok: false, nodes: [{ id: 'plan', status: 'done' }, { id: 'a', status: 'blocked' }] };
  const { tree, calls } = mount({ run_x_1: failed });

  const btn = resumeButtonOf(tree);
  assert.ok(btn !== undefined, '存在失败步骤的运行必须给出续跑入口');
  assert.deepEqual(textsOf(btn), ['续跑'], '按钮文案必须是「续跑」');

  await btn.props.onClick();
  assert.deepEqual(calls.resume, ['run_x_1'], '必须按该运行的 runId 发 graph.resume');
  assert.deepEqual(
    calls.runStart,
    [['run_x_1', 'sample-research']],
    '必须走既有 onRunStart 复位通道（同一 runId），否则进度订阅会对不上',
  );
  assert.deepEqual(calls.toasts, [['已续跑：run_x_1', 'ok']], '成功必须如实提示');
});

test('续跑失败 ⇒ 如实 toast，不静默吞掉', async () => {
  const { tree, calls } = mount(
    { run_y_1: { runId: 'run_y_1', defName: 'demo', done: true, ok: false, nodes: [] } },
    { resumeResult: undefined },
  );
  runtime.appContext.api.resumeGraph = async () => {
    throw new Error('找不到运行日志：/tmp/x/run_y_1.jsonl');
  };
  const btn = resumeButtonOf(tree);
  assert.ok(btn !== undefined);
  await btn.props.onClick();
  assert.equal(calls.toasts.length, 1, '失败必须有一条提示');
  assert.match(calls.toasts[0][0], /续跑失败：找不到运行日志/);
  assert.equal(calls.toasts[0][1], 'err');
  assert.deepEqual(calls.runStart, [], '失败不得复位运行态（否则卡片会假装在跑）');
});
