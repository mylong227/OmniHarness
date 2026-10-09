// 续跑**唯一实现**（`GraphController.resumeRun`）的判据（2026-10-08）。
//
// 为什么钉在控制器：交互改进后「编排面板卡片」与「状态栏芯片」共用这一个方法，
// 它承担了三条容易写错、写错了很难发现的行为：
//   ① **乐观复位**：点击后立刻把运行置回「运行中」，按钮随之消失 ⇒ 从根上消掉连点窗口
//      （服务端对同一 runId 的在飞续跑是 fail-closed 拒绝的，连点只会换来报错，体感更差）；
//   ② **失败必须复原**：RPC 失败要把运行态恢复成「未成功」，绝不让卡片停在「运行中…」假装在跑；
//   ③ **SSE 断开时回退轮询**：否则界面永远停在「运行中…」（没有推送也没有轮询）。
//
// 手法：零 DOM 桩 + 手写 host/services（与 controllerBindings.test.mjs 同款）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { GraphController } = await import('../dist/ui/controllers/GraphController.js');
const { AppReducers } = await import('../dist/ui/controllers/AppReducers.js');

/**
 * 造一个可观测的控制器宿主与服务。
 * @param opts.api 覆写 api（resumeGraph / graphStatus）
 * @param opts.streamOpen SSE 是否连通
 * @returns 控制器与记录容器
 */
function makeController(opts = {}) {
  const calls = { resume: [], status: [], toasts: [], patches: [] };
  const state = {
    graphRuns: {
      run_x_1: {
        runId: 'run_x_1',
        defName: 'sample-research',
        done: true,
        ok: false,
        nodes: [
          { id: 'plan', status: 'done' },
          { id: 'b', status: 'blocked' },
        ],
      },
    },
  };
  const host = {
    patch(action) {
      const next = typeof action === 'function' ? action(state) : action;
      calls.patches.push(next);
      Object.assign(state, next);
    },
    getState: () => state,
  };
  const services = {
    api: {
      resumeGraph: async (runId) => {
        calls.resume.push(runId);
        if (opts.resumeError !== undefined) throw new Error(opts.resumeError);
        return { runId, nodeCount: 2 };
      },
      graphStatus: async (runId) => {
        calls.status.push(runId);
        return { runId, defName: 'sample-research', done: true, ok: true, nodes: [] };
      },
    },
    stream: { isOpen: opts.streamOpen !== false },
    toast: (message, kind) => calls.toasts.push([message, kind]),
    reducers: new AppReducers(),
  };
  return { ctrl: new GraphController(host, services), state, calls };
}

/** 等一轮微任务，让 `resumeRun` 内部的 await 落地。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('resumeRun：乐观复位（立刻变运行中）+ 发 graph.resume + 成功提示', async () => {
  const { ctrl, state, calls } = makeController();
  const pending = ctrl.resumeRun('run_x_1', 'sample-research');

  // 还没等 RPC 回来：运行态必须**已经**回落到「运行中」（按钮随之消失 ⇒ 无连点窗口）。
  assert.strictEqual(state.graphRuns.run_x_1.done, false, '乐观复位必须立刻生效');
  assert.strictEqual(state.graphRuns.run_x_1.ok, undefined);

  await pending;
  assert.deepEqual(calls.resume, ['run_x_1']);
  assert.strictEqual(calls.toasts.length, 1);
  assert.match(calls.toasts[0][0], /已续跑/);
  assert.strictEqual(calls.toasts[0][1], 'ok');
});

test('resumeRun：RPC 失败 ⇒ 复原成未成功并如实报错（绝不假装在跑）', async () => {
  const { ctrl, state, calls } = makeController({ resumeError: '找不到运行日志：/tmp/x.jsonl' });
  await ctrl.resumeRun('run_x_1', 'sample-research');

  assert.strictEqual(state.graphRuns.run_x_1.done, true, '失败必须复原成「已结束」');
  assert.strictEqual(state.graphRuns.run_x_1.ok, false, '必须复原成「未成功」（按钮随之回来）');
  assert.deepEqual(
    state.graphRuns.run_x_1.nodes.map((n) => n.id),
    ['plan', 'b'],
    '复原必须带回原来的节点状态，不能清空',
  );
  assert.strictEqual(calls.toasts.length, 1);
  assert.match(calls.toasts[0][0], /续跑失败：找不到运行日志/);
  assert.strictEqual(calls.toasts[0][1], 'err');
});

test('resumeRun：SSE 未连通 ⇒ 回退轮询（否则界面永远停在运行中）', async () => {
  const { ctrl, calls } = makeController({ streamOpen: false });
  await ctrl.resumeRun('run_x_1', 'sample-research');
  await tick();
  assert.ok(calls.status.includes('run_x_1'), 'SSE 断开时必须发起 graphStatus 轮询');
});

test('resumeRun：SSE 已连通 ⇒ 不轮询（推送才是唯一真源，避免多余 RPC）', async () => {
  const { ctrl, calls } = makeController();
  await ctrl.resumeRun('run_x_1', 'sample-research');
  await tick();
  assert.deepEqual(calls.status, []);
});

test('applyGraphDone：失败时主动提示「可续跑」（不必先学会导航才知道）', () => {
  const { ctrl, calls } = makeController();
  ctrl.applyGraphDone({ runId: 'run_x_1', ok: false });
  assert.strictEqual(calls.toasts.length, 1);
  assert.match(calls.toasts[0][0], /sample-research/);
  assert.match(calls.toasts[0][0], /续跑/);
  assert.strictEqual(calls.toasts[0][1], 'err');

  // 成功收尾不该打扰用户。
  const ok = makeController();
  ok.ctrl.applyGraphDone({ runId: 'run_x_1', ok: true });
  assert.deepEqual(ok.calls.toasts, []);
});
