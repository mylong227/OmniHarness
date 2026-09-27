// 删除会话的**列表刷新**门禁（零 DOM、真 reducer）：用户报「删除并未刷新」+「删除失败: session_not_found」。
//
// ## 缺陷形态（2026-09-27 截图）
//
// ① 删除成功后行**不消失**：刷新走 `AppReducers.mergeSessions(prev, fromDisk)`，其契约是「保留内存态中
//    **未落盘**的会话」；而删除成功后该 id 恰好「不在磁盘上」⇒ 被当成「未落盘的新会话」原样留下。
//    文件删了、行还在。
// ② 再点一次删除 ⇒ 服务端 `session_not_found`（文件真没了），界面仍只留一句错误、行仍在。
// ③ 只存在于内存（尚未落盘 / 落盘失败）的会话，点删除恒为 `session_not_found`，且**永远删不掉**。
//
// ## 判据
//
// 用**真的** `mergeSessions` 驱动控制器：① 成功删除后该行必须不在列表里；② `session_not_found`
// 也要把本地行摘掉（磁盘上本来就没有），且不得弹「删除失败」；③ `session_running` 必须**保留**该行
// 并给出可执行的下一步。
//
// 直跑：node --test web/test/sessionDeleteRefresh.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

// deps.js / highlight.js 在模块顶层读 window，须先种零 DOM 桩（与 controllerBindings.test.mjs 同一口径）。
createRuntime().install();
const { SessionController } = await import('../dist/ui/controllers/SessionController.js');
const { AppReducers } = await import('../dist/ui/controllers/AppReducers.js');

/** 造一个最小 host/services 环境：reducers 用**真实现**（缺陷就出在 mergeSessions 的契约上）。
 *  注意 `listSessions` 的线格式是 `sessionId`（refreshSessions 用它做 id），不是 `id`。 */
function disk(sessionId, running = false) {
  return { sessionId, label: sessionId, workspace: 'w', updatedAt: '', turns: 1, running };
}

/**
 * @param diskSessions 磁盘上现存的会话（线格式 `sessionId`）。
 * @param deleteResult 服务端删除结果。
 * @returns 控制器、状态与 toast 记录。
 */
function makeEnv(diskSessions, deleteResult) {
  const reducers = new AppReducers();
  const toasts = [];
  const state = {
    currentThreadId: 's1',
    sessions: [
      { id: 's1', label: '甲', workspace: 'w', updatedAt: '', turns: 1, running: false },
      { id: 's2', label: '乙', workspace: 'w', updatedAt: '', turns: 1, running: false },
    ],
    events: [],
    toolResults: {},
    liveInputs: [],
    streamText: '',
  };
  const host = {
    patch(action) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const services = {
    api: {
      deleteSession: async () => deleteResult,
      listSessions: async () => ({ sessions: diskSessions }),
    },
    toast: (m) => toasts.push(m),
    navigate: () => {},
    reducers: { mergeSessions: (prev, disk) => reducers.mergeSessions(prev, disk) },
  };
  return { ctrl: new SessionController(host, services), state, toasts };
}

test('① 删除成功后该行必须从列表消失（mergeSessions 不得把它当「未落盘会话」留下）', async () => {
  // 磁盘上只剩 s2（s1 已被服务端删掉）
  const env = makeEnv([disk('s2')], {
    ok: true,
  });
  await env.ctrl.deleteSession('s1');
  assert.deepStrictEqual(
    env.state.sessions.map((s) => s.id),
    ['s2'],
    `删除后列表仍是 ${JSON.stringify(env.state.sessions.map((s) => s.id))}（行未被摘掉 ⇒ 用户看到「删除并未刷新」）`,
  );
  assert.ok(
    env.toasts.some((t) => t.includes('已删除')),
    `应有成功提示，实测 ${JSON.stringify(env.toasts)}`,
  );
});

test('② 磁盘上本来就没有（session_not_found）⇒ 摘掉本地行、不报错', async () => {
  // 典型：UI 里刚发出、尚未落盘的会话行；或「文件已删但行被 mergeSessions 留下」时的第二次点击
  const env = makeEnv([disk('s2')], {
    ok: false,
    error: 'session_not_found',
  });
  await env.ctrl.deleteSession('s1');
  assert.deepStrictEqual(
    env.state.sessions.map((s) => s.id),
    ['s2'],
    '磁盘上没有的会话必须从本地列表摘掉（否则永远删不掉的幽灵行）',
  );
  assert.ok(
    !env.toasts.some((t) => t.includes('删除失败')),
    `不该报错（磁盘上本就没有），实测 ${JSON.stringify(env.toasts)}`,
  );
});

test('③ 运行中被拒 ⇒ 保留该行，并说清下一步（先停止再删）', async () => {
  const env = makeEnv([disk('s1', true)], {
    ok: false,
    error: 'session_running',
  });
  await env.ctrl.deleteSession('s1');
  assert.deepStrictEqual(
    env.state.sessions.map((s) => s.id),
    ['s1', 's2'],
    '运行中被拒时必须保留该行（它确实还在磁盘上）',
  );
  assert.ok(
    env.toasts.some((t) => t.includes('停止')),
    `提示必须给出可执行的下一步，实测 ${JSON.stringify(env.toasts)}`,
  );
});
