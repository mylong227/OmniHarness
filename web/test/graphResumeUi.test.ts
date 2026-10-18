// 「编排」面板的**续跑入口**判据（2026-10-08）。
//
// 契约（2026-10-08 交互改进后）：组件**不再自己发 RPC**——续跑实现只有一处
// （`GraphController.resumeRun`，状态栏芯片也用同一实现），组件通过 `onResume` 上抛。
// 本判据钉三件事：
//   ① 只有「已结束且未成功」的运行才出现按钮（运行中/已成功显示了只会误导）；
//   ② 点击把 (runId, name) 交给 `onResume`（控制器负责乐观复位、失败复原与提示）；
//   ③ 文案自己说清「跳过已完成 N 步」——用户最担心的就是「会不会整张图重跑一遍」。
//
// 手法与 mount.test.mjs / questionCard.test.mjs 一致：零 DOM 桩 + hooksStub 的 hook 槽位运行时。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRuntime } from './hooksStub.ts';

const runtime = createRuntime();
runtime.install();

const { GraphTab } = await import('../src/ui/components/tabs/GraphTab.tsx');

/** 桩 vnode 的形状（createElement 产物；只声明本判据读写的字段）。 */
interface TestNode {
  type?: unknown;
  props?: Record<string, unknown> & { onClick?: () => void };
  children?: unknown[];
}

/**
 * 递归展开函数组件节点（零 DOM 环境里 createElement 不会实例化子组件）。
 * @param vnode 节点
 * @returns 展开后的节点树
 */
function expand(vnode: unknown): unknown {
  if (vnode == null || typeof vnode !== 'object') return vnode;
  const v = vnode as TestNode;
  if (typeof v.type === 'function') {
    return expand((v.type as (props: unknown) => unknown)(v.props));
  }
  return { ...vnode, children: (v.children ?? []).flat(Infinity).map(expand) };
}

/**
 * 深度收集元素节点。
 * @param vnode 节点
 * @returns 元素节点数组
 */
function walk(vnode: unknown): TestNode[] {
  if (vnode == null || typeof vnode !== 'object') return [];
  const v = vnode as TestNode;
  return [v, ...(v.children ?? []).flat(Infinity).flatMap(walk)];
}

/**
 * 取节点 className。
 * @param vnode 节点
 * @returns className（非字符串时为空串）
 */
function clsOf(vnode: unknown): string {
  const props = (vnode as TestNode | null)?.props;
  return typeof props?.className === 'string' ? props.className : '';
}

/**
 * 收集子树全部文本。
 * @param vnode 节点
 * @returns 文本数组
 */
function textsOf(vnode: unknown): string[] {
  if (vnode == null) return [];
  if (typeof vnode === 'string' || typeof vnode === 'number') return [String(vnode)];
  if (typeof vnode !== 'object') return [];
  const v = vnode as TestNode;
  return (v.children ?? []).flat(Infinity).flatMap(textsOf);
}

/**
 * 渲染一次 GraphTab。
 * @param runs 运行态映射
 * @returns 渲染结果与调用记录
 */
function mount(runs: Record<string, unknown>) {
  const calls = {
    resume: [] as [string, string][],
    runStart: [] as [string, string][],
  };
  // hooksStub 的桩 api 类型未声明 listGraphs（GraphTab 实际会调用），这里只扩桩不改行为。
  runtime.appContext.api = { ...runtime.appContext.api, listGraphs: async () => [] } as typeof runtime.appContext.api;
  runtime.appContext.toast = () => {};
  const tree = expand(
    runtime.render(GraphTab, {
      graphRuns: runs,
      onRunStart: (runId: string, name: string) => calls.runStart.push([runId, name]),
      onResume: (runId: string, name: string) => calls.resume.push([runId, name]),
    }),
  );
  return { tree, calls };
}

test('运行未结束 / 已成功时**不**显示续跑按钮（显示了只会误导）', () => {
  const running = mount({ r1: { runId: 'r1', defName: 'demo', done: false, nodes: [] } });
  assert.strictEqual(walk(running.tree).find((n) => clsOf(n).includes('btn-resume')), undefined);

  const passed = mount({ r2: { runId: 'r2', defName: 'demo', done: true, ok: true, nodes: [] } });
  assert.strictEqual(walk(passed.tree).find((n) => clsOf(n).includes('btn-resume')), undefined);
});

test('已结束但未成功 ⇒ 按钮出现、文案自解释、点击交给 onResume', () => {
  const { tree, calls } = mount({
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
  const btn = walk(tree).find((n) => clsOf(n).includes('btn-resume'));
  assert.ok(btn !== undefined, '存在失败/被阻塞步骤的运行必须给出续跑入口');
  assert.deepEqual(textsOf(btn), ['续跑（跳过已完成 2 步）'], '文案必须自解释会跳过几步');
  assert.match(String(btn.props!.title), /复用已完成 2 步的产出，只重跑剩下 1 步/);

  btn.props!.onClick!();
  assert.deepEqual(calls.resume, [['run_x_1', 'sample-research']], '必须把 runId 与名字交给控制器');
  assert.deepEqual(calls.runStart, [], '组件不再自己复位状态（避免与控制器两套实现漂移）');
});

test('节点列表为空（还没收到任何 progress）⇒ 退化为朴素文案，不编造步数', () => {
  const { tree } = mount({
    run_y_1: { runId: 'run_y_1', defName: 'demo', done: true, ok: false, nodes: [] },
  });
  const btn = walk(tree).find((n) => clsOf(n).includes('btn-resume'));
  assert.ok(btn !== undefined);
  assert.deepEqual(textsOf(btn), ['续跑'], '没有节点数据时不得显示「跳过已完成 0 步」这类误导文案');
});
