// 工作区切换的**列表与视图**收口门禁（真控制器 + 真 reducer，零 DOM）。
//
// ## 缺陷形态（2026-10-07 用户报「切换不同的工作区，会话列表还是显示之前的会话」）
//
// ① 旧 `mergeSessions` 契约是「保留在册未落盘的会话」：服务端 `sessions.list` 按当前工作区过滤，
//    切到别的项目后旧会话正好「不在响应里」⇒ 被旧契约当成"未落盘"原样留在内存列表——
//    换了项目，侧栏还挂着上一个项目的全部会话。
// ② 中栏视图也不收口：currentThreadId / 事件流还挂着旧项目的对话。
//
// ## 判据
//
// `onWorkspaceSwitched()` 之后：内存列表 = 新工作区响应（旧项目会话消失、已归档保留）；
// currentThreadId 为 null、事件流清空、hash 去掉 threadId。
//
// 直跑：node --test web/test/workspaceSwitch.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

createRuntime().install();
const { SessionController } = await import('../dist/ui/controllers/SessionController.js');
const { AppReducers } = await import('../dist/ui/controllers/AppReducers.js');

test('onWorkspaceSwitched：列表换新工作区响应（旧项目消失、归档保留），视图清空', async () => {
  const toasts = [];
  const navs = [];
  const reducers = new AppReducers();
  const state = {
    currentThreadId: 'old-1',
    sessions: [
      { id: 'old-1', label: '旧项目会话', workspace: 'D:/old', updatedAt: '', turns: 1, running: false, archived: false },
      { id: 'arch-1', label: '归档会话', workspace: 'D:/old', updatedAt: '', turns: 2, running: false, archived: true },
    ],
    events: [{ id: 'e1', type: 'user', timestamp: 0, payload: { content: '旧对话' } }],
    toolResults: {},
    liveInputs: [],
    streamText: '旧流式',
    finalizedStreamText: '',
    busy: false,
    activeTool: null,
  };
  const host = {
    patch(action) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const services = {
    api: {
      // 新工作区的响应只含 new-1：old-1 不在响应里（服务端已按工作区过滤）。
      listSessions: async () => ({
        dir: 'd',
        sessions: [{ sessionId: 'new-1', label: '新项目会话', workspace: 'D:/new', updatedAt: '', turns: 1 }],
      }),
    },
    toast: (message, kind) => toasts.push([message, kind]),
    navigate: (partial) => navs.push(partial),
    reducers,
  };
  const ctrl = new SessionController(host, services);
  await ctrl.onWorkspaceSwitched();

  assert.deepStrictEqual(
    state.sessions.map((s) => s.id),
    ['arch-1', 'new-1'],
    '旧项目的未归档会话必须消失；已归档保留（快速刷新契约）；新项目会话进列表',
  );
  assert.strictEqual(state.currentThreadId, null, '旧项目的当前会话必须清空');
  assert.deepStrictEqual(state.events, [], '旧项目的事件流必须清空');
  assert.strictEqual(state.streamText, '', '旧项目的流式缓冲必须清空');
  assert.ok(navs.some((n) => n.threadId === null), 'hash 必须去掉 threadId（回到无会话视图）');
});
