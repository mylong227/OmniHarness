// 会话模式的「建会话前先暂存」时序：真机报错「模式切换失败：modes.set 需要 threadId」的回归判据。
//
// ## 现场（2026-10-06 用户截图）
//
// 会话是**惰性创建**的（发第一条消息时 `turns.run` 才建），而「目标 / 计划模式 / 绘图」按会话持久化。
// 于是用户在还没发过消息时点「+ → 计划模式」，前端把空 threadId 直接发给服务端 ⇒ 弹红字报错。
//
// ## 修法（本判据锁住的契约）
//
// 控制器 `SessionController.applyModes` 统一决策：有会话 ⇒ 立刻 `modes.set`；
// 没会话 ⇒ **暂存**，等会话出现（`ComposerController` 拿到 `res.threadId` 后）自动落盘。
import assert from 'node:assert/strict';
import test from 'node:test';

// 控制器链会经 `deps.js` 摸 `window`（React UMD 宿主）。node 下给个最小壳即可——
// 本判据考的是**时序**（暂存 / 落盘），与 DOM 无关。
globalThis.window = globalThis.window ?? {
  React: { createElement: () => ({}) },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { SessionController } = await import('../dist/ui/controllers/SessionController.js');
const { PendingModes } = await import('../dist/ui/models/PendingModes.js');

/**
 * 构造状态宿主桩（patch 真写状态，getState 返回最新）。
 * @param currentThreadId 初始当前会话 id（null = 尚未创建）。
 * @returns 宿主与状态
 */
function makeHost(currentThreadId) {
  const state = { currentThreadId, sessions: [], events: [] };
  const host = {
    patch(action) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState() {
      return state;
    },
  };
  return { host, state };
}

/**
 * 构造只记录 modesSet 调用的 api 桩。
 * @returns 记录数组与 api
 */
function makeApi() {
  const calls = [];
  return {
    calls,
    api: {
      modesSet: (threadId, patch) => {
        calls.push({ threadId, patch });
        return Promise.resolve({ goal: '', planMode: false, sketchMode: false, ...patch });
      },
    },
  };
}

/**
 * 构造控制器。
 * @param currentThreadId 当前会话 id
 * @returns 控制器 / 状态 / 调用记录
 */
function makeController(currentThreadId) {
  const { host, state } = makeHost(currentThreadId);
  const { calls, api } = makeApi();
  const controller = new SessionController(host, { api });
  return { controller, state, calls };
}

test('无会话时切换模式：**暂存**而不是报错（真机报错现象的回归判据）', async () => {
  const { controller, state, calls } = makeController(null);
  const outcome = await controller.applyModes({ planMode: true });
  assert.equal(outcome, 'deferred', '没有会话时必须是 deferred，而不是把空 threadId 发给服务端');
  assert.equal(calls.length, 0, '暂存阶段不得发起 modes.set（那正是报错的来源）');
  await controller.modes.flush(''); // 空 id 也不该乱发
  assert.equal(calls.length, 0);
  assert.equal(state.currentThreadId, null);
});

test('会话出现后自动落盘：暂存的补丁原样写给新会话，且只发一次', async () => {
  const { controller, calls } = makeController(null);
  await controller.applyModes({ planMode: true });
  await controller.applyModes({ goal: '把召回率提到 60%' });
  await controller.modes.flush('sess_new_1');
  assert.deepEqual(calls, [
    { threadId: 'sess_new_1', patch: { planMode: true, goal: '把召回率提到 60%' } },
  ]);
  // 幂等：再冲刷一次不该重复发
  await controller.modes.flush('sess_new_1');
  assert.equal(calls.length, 1);
});

test('已有会话时切换模式：立刻落盘，不进暂存', async () => {
  const { controller, calls } = makeController('sess_existing');
  const outcome = await controller.applyModes({ sketchMode: true });
  assert.equal(outcome, 'applied');
  assert.deepEqual(calls, [{ threadId: 'sess_existing', patch: { sketchMode: true } }]);
});

test('补丁合并语义：后者覆盖同名、其余保留；空补丁可识别', () => {
  const merged = PendingModes.merge({ planMode: true, goal: 'a' }, { goal: 'b' });
  assert.deepEqual(merged, { planMode: true, goal: 'b' });
  assert.equal(PendingModes.isEmpty({}), true);
  assert.equal(PendingModes.isEmpty({ planMode: false }), false, 'false 是有效补丁（要显式关闭）');
  assert.match(PendingModes.deferredHint(), /发送第一条消息后/);
});
