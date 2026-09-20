// 流式节流接线测试：`StreamThrottle` 真的接在 `SessionController.appendTextDelta` 上，
// 且「高频增量 → 有界刷新」与「收尾零丢失」两条不变量在**接线后**依然成立。
//
// 为什么单独一个文件：`longSessionPerf.test.mjs` 验的是节流器本身的纯逻辑；本文件验的是
// 「它是否真的被生产路径使用」——这正是本仓历史上最高频的缺陷形态（写了但没接线）。
// 直跑：node web/test/streamThrottleWiring.test.mjs（需先 npm run web:build）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

// `deps.js` 在模块顶层读 `window`（SessionController 经 highlight.js 间接引入它），
// 故必须先种零 DOM 桩再动态 import 编译产物——与 mount.test.mjs 同一口径。
createRuntime().install();

const { SessionController } = await import('../dist/ui/controllers/SessionController.js');

/** 造一个记录 patch 次数的状态宿主（streamText 真累积）。 */
function makeHost(initial = {}) {
  const state = {
    events: [],
    streamText: '',
    finalizedStreamText: '',
    toolResults: {},
    liveInputs: [],
    activeTool: null,
    busy: true,
    ...initial,
  };
  const host = {
    patchCount: 0,
    patch(action) {
      const next = typeof action === 'function' ? action(state) : action;
      host.patchCount += 1;
      Object.assign(state, next);
    },
    getState() {
      return state;
    },
  };
  return { host, state };
}

/** 服务桩：只用 appendTextDelta 这一条 reducer。 */
function makeServices() {
  return {
    reducers: {
      appendTextDelta: (prev, text) => prev + text,
      ingestEvent: (s) => s,
      mergeToolResult: (t) => t,
      mergeToolInput: (inputs) => inputs,
    },
  };
}

test('接线：高频增量被合并成有界刷新次数，且累计文本逐字节一致', async () => {
  const { host, state } = makeHost();
  const ctrl = new SessionController(host, makeServices());
  const deltas = Array.from({ length: 500 }, (_, i) => `t${i};`);
  const expected = deltas.join('');

  for (const delta of deltas) ctrl.appendTextDelta({ text: delta });
  const duringFlight = host.patchCount;
  ctrl.flushStream();

  assert.ok(duringFlight <= 5, `500 条增量在飞期间刷新次数应为常数级，实测 ${duringFlight}`);
  assert.strictEqual(state.streamText, expected, 'flush 后累计文本必须与逐条拼接逐字节一致');
});

test('接线：收尾 flush 之后到达的迟到增量一律无效（不复活流式卡片）', () => {
  const { host, state } = makeHost();
  const ctrl = new SessionController(host, makeServices());
  ctrl.appendTextDelta({ text: '前段' });
  ctrl.flushStream();
  const afterFlush = state.streamText;

  // 回合已结束（busy=false）后迟到的增量
  host.patch({ busy: false });
  ctrl.appendTextDelta({ text: '迟到' });
  ctrl.flushStream();
  assert.strictEqual(state.streamText, afterFlush, '停表后的迟到增量不得进入状态');
});

test('接线：未 flush 的缓冲不会凭空进入状态（节流是有意的），但 flush 一定补齐', () => {
  const { host, state } = makeHost();
  const ctrl = new SessionController(host, makeServices());
  ctrl.appendTextDelta({ text: 'a' });
  ctrl.appendTextDelta({ text: 'b' });
  // 首条立即刷出；第二条可能仍在缓冲里——两种中间态都合法，但绝不能丢。
  ctrl.flushStream();
  assert.strictEqual(state.streamText, 'ab');
});

test('接线：空增量与非字符串 text 不产生刷新（避免无意义重渲染）', () => {
  const { host } = makeHost();
  const ctrl = new SessionController(host, makeServices());
  const before = host.patchCount;
  ctrl.appendTextDelta({ text: '' });
  ctrl.appendTextDelta({ text: 42 });
  ctrl.appendTextDelta({});
  assert.strictEqual(host.patchCount, before, '空/非法增量不得触发 patch');
});
