// F4 中断 / 重生成 / 编辑重发：前端接线契约测试。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';

const { ApiClient } = await import('../dist/core/ApiClient.js');
const { ComposerController } = await import('../dist/ui/controllers/ComposerController.js');

/** 一个可控的延迟（用于模拟「回合仍在飞」）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 构造状态宿主桩：patch 真写状态（settleRound / rewindTo 都是函数式补丁，必须真应用）。
 * @param events 初始事件
 * @param extra 追加状态字段
 * @returns 宿主与状态对象
 */
function makeHost(events, extra = {}) {
  const state = {
    events,
    currentThreadId: 't1',
    sessions: [],
    streamText: '',
    finalizedStreamText: '',
    busy: false,
    activeTool: null,
    liveInputs: [],
    toolResults: {},
    composerSeed: null,
    ...extra,
  };
  const host = {
    patches: [],
    patch(action) {
      const next = typeof action === 'function' ? action(state) : action;
      host.patches.push(next);
      Object.assign(state, next);
    },
    getState() {
      return state;
    },
  };
  return { host, state };
}

/**
 * 构造最小可控的 ComposerController（host/services/sessions 全 mock）。
 * @param host 状态宿主
 * @param api API 桩
 * @returns 控制器与桩
 */
function makeController(host, api) {
  const services = {
    api,
    toast: () => {},
    reducers: { appendFinalText: (events) => events },
    stream: {},
    toastSvc: {},
    dialogSvc: {},
    navigate: () => {},
  };
  const sessions = { async refreshSessions() {}, flushStream() {} };
  return new ComposerController(host, services, sessions);
}

/** 构造可用的 API 桩（runTurn 立即成功；rewindThread 默认成功——重生成先回退服务端）。 */
function makeApi() {
  return {
    runTurnCalls: [],
    rewindCalls: [],
    abortCalls: 0,
    abortArgs: [],
    async runTurn(params) {
      this.runTurnCalls.push(params);
      return { threadId: 't1' };
    },
    async rewindThread(threadId, keepEventId) {
      this.rewindCalls.push({ threadId, keepEventId });
      return { ok: true, kept: 1, dropped: 1 };
    },
    abortTurn(threadId) {
      this.abortCalls += 1;
      this.abortArgs.push(threadId);
      return Promise.resolve({ ok: true });
    },
  };
}

/** 取出流里的 system 提示文案。 */
function systemNotes(state) {
  return state.events.filter((e) => e.type === 'system').map((e) => String(e.payload?.content ?? ''));
}

test('abortTurn 调用 turns.abort RPC', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }) };
  };
  const api = new ApiClient();
  const res = await api.abortTurn();
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.method, 'turns.abort');
  assert.deepEqual(body.params, {});
});

test('stop：在飞回合立即停 UI（清流式与忙碌 + 写已中止）并调 turns.abort', async () => {
  const { host, state } = makeHost([{ id: 'u1', type: 'user', payload: { content: '问题' } }]);
  const api = makeApi();
  const gate = deferred();
  api.runTurn = (params) => {
    api.runTurnCalls.push(params);
    return gate.promise;
  };
  const ctrl = makeController(host, api);
  const running = ctrl.send('问题', [], []);

  // 模拟流式进行中：已累积半截正文 + 一条流式工具输入 + 活动工具。
  host.patch({ streamText: '半截回答', liveInputs: [{ id: 'c1', name: 'shell', partial: '{}' }], activeTool: 'shell' });
  assert.equal(state.busy, true, '发送后必须处于忙碌态');

  ctrl.stop();
  assert.equal(api.abortCalls, 1, 'stop 必须调 turns.abort');
  // 2026-09-22：必须带上当前 threadId——服务端允许多回合并行，不带 id 会退化为「取消全部在跑回合」，
  // 并发会话下等于误停别人的任务（后端按 sessionId 定向取消，见 src/core/agent.ts）。
  assert.deepEqual(
    api.abortArgs,
    ['t1'],
    'stop 必须把当前 threadId 传给 turns.abort（防并发会话误停）',
  );
  assert.equal(state.busy, false, '停止必须立即清掉忙碌态（不等后端回执）');
  assert.equal(state.streamText, '', '停止后不得残留流式缓冲');
  assert.deepEqual(state.liveInputs, [], '停止后不得残留流式工具输入');
  assert.equal(state.activeTool, null, '停止后不得残留活动工具');
  assert.equal(state.finalizedStreamText, '半截回答', '已流出的半截正文收口为「已定稿」');
  assert.deepEqual(systemNotes(state), ['已中止（用户中断）。'], '写且只写一条「已中止」提示');

  // 后端随后以拒绝收尾：仍不得残留 streaming，也不得重复提示。
  gate.reject(new Error('aborted'));
  await running;
  assert.equal(state.busy, false);
  assert.equal(state.streamText, '');
  assert.deepEqual(systemNotes(state), ['已中止（用户中断）。'], '中止提示不得重复');
});

test('stop：后端以正常响应收尾时不补最终回复（避免「停了又冒一条」）', async () => {
  const { host, state } = makeHost([{ id: 'u1', type: 'user', payload: { content: '问题' } }]);
  const api = makeApi();
  const gate = deferred();
  api.runTurn = (params) => {
    api.runTurnCalls.push(params);
    return gate.promise;
  };
  const ctrl = makeController(host, api);
  const running = ctrl.send('问题', [], []);
  ctrl.stop();
  gate.resolve({ threadId: 't1', finalText: '迟到的完整回复' });
  await running;
  assert.equal(state.events.filter((e) => e.type === 'assistant').length, 0, '中止后不得补写助手事件');
  assert.equal(state.streamText, '', '中止后不得残留流式缓冲');
  assert.equal(state.busy, false);
});

test('stop：无在飞回合时不误触后端，后续真实失败仍按失败报错', async () => {
  const { host, state } = makeHost([]);
  const api = makeApi();
  const ctrl = makeController(host, api);
  ctrl.stop();
  assert.equal(api.abortCalls, 0, '空闲时 stop 不得调 turns.abort');

  api.runTurn = async () => {
    throw new Error('boom');
  };
  await ctrl.send('会失败的回合', [], []);
  assert.equal(
    systemNotes(state).filter((n) => n.includes('运行失败')).length,
    1,
    '真实失败必须按失败提示',
  );
  assert.equal(
    systemNotes(state).filter((n) => n.includes('已中止')).length,
    0,
    '空闲 stop 不得污染下一次回合的中止判定',
  );
});

test('regenerate：回退到末条用户消息后重发，并丢弃孤儿工具结果', async () => {
  const events = [
    { id: 'u1', type: 'user', payload: { content: '第一条' } },
    { id: 'a1', type: 'assistant', payload: { content: '回复1' } },
    { id: 't1', type: 'tool_call', payload: { callId: 'c1', name: 'shell' } },
    { id: 'u2', type: 'user', payload: { content: '第二条' } },
    { id: 't2', type: 'tool_call', payload: { callId: 'c2', name: 'read' } },
    { id: 'a2', type: 'assistant', payload: { content: '回复2' } },
  ];
  const { host, state } = makeHost(events, {
    toolResults: { c1: { text: 'ok', ok: true }, c2: { text: 'late', ok: true }, orphan: { text: 'x', ok: false } },
    streamText: '半截',
    currentThreadId: 't1',
  });
  const api = makeApi();
  const ctrl = makeController(host, api);
  await ctrl.regenerate();

  assert.deepEqual(
    state.events.map((e) => e.id),
    ['u1', 'a1', 't1', 'u2'],
    '必须回退到末条用户消息（含），丢弃其后的助手 / 过程事件',
  );
  assert.deepEqual(Object.keys(state.toolResults), ['c1'], '只保留仍在事件流里的工具结果');
  assert.equal(state.streamText, '', '回退时清掉流式残留');
  assert.equal(api.runTurnCalls.length, 1, '重生成复用既有点提交通路');
  assert.equal(api.runTurnCalls[0].prompt, '第二条');
  assert.equal(api.runTurnCalls[0].threadId, 't1');
  // 服务端真回退：必须以末条用户事件的**服务端 id**为准（否则服务端存档里旧一轮仍在）。
  assert.deepEqual(
    api.rewindCalls,
    [{ threadId: 't1', keepEventId: 'u2' }],
    '重生成前必须请服务端截断到末条用户消息',
  );
});

test('regenerate：服务端回退失败 ⇒ 不重发、不假装成功（toast 报原因）', async () => {
  const events = [
    { id: 'u1', type: 'user', payload: { content: '第一条' } },
    { id: 'a1', type: 'assistant', payload: { content: '回复1' } },
  ];
  const { host, state } = makeHost(events, { currentThreadId: 't1' });
  const toasts = [];
  const api = makeApi();
  api.rewindThread = async (threadId, keepEventId) => {
    api.rewindCalls.push({ threadId, keepEventId });
    return { ok: false, error: '该会话有回合正在运行：请先中止再回退' };
  };
  const services = {
    api,
    toast: (m, kind) => toasts.push({ m, kind }),
    reducers: { appendFinalText: (events2) => events2 },
    stream: {},
    toastSvc: {},
    dialogSvc: {},
    navigate: () => {},
  };
  const ctrl = new ComposerController(host, services, { async refreshSessions() {}, flushStream() {} });
  await ctrl.regenerate();

  assert.equal(api.runTurnCalls.length, 0, '服务端未回退时绝不重发（否则等于接着旧答案追加一轮）');
  assert.deepEqual(
    state.events.map((e) => e.id),
    ['u1', 'a1'],
    '回退失败时本地视图也不得被截断（视图与事实源保持一致）',
  );
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].m, /重生成失败（服务端未回退）/);
  assert.equal(toasts[0].kind, 'err');
});

test('regenerate：无 currentThreadId（纯本地会话）⇒ 不调服务端，仍可本地回退重发', async () => {
  const events = [
    { id: 'u1', type: 'user', payload: { content: '问题' } },
    { id: 'a1', type: 'assistant', payload: { content: '回复' } },
  ];
  const { host, state } = makeHost(events, { currentThreadId: null });
  const api = makeApi();
  const ctrl = makeController(host, api);
  await ctrl.regenerate();
  assert.deepEqual(api.rewindCalls, [], '没有服务端会话时不该凭空调回退 RPC');
  assert.deepEqual(state.events.map((e) => e.id), ['u1']);
  assert.equal(api.runTurnCalls.length, 1);
});

test('regenerate 无用户消息时仅轻提示、不发起请求', async () => {
  const { host } = makeHost([{ id: 'a1', type: 'assistant', payload: { content: 'x' } }]);
  const toasts = [];
  const api = makeApi();
  const services = {
    api,
    toast: (m) => toasts.push(m),
    reducers: { appendFinalText: (events) => events },
    stream: {},
    toastSvc: {},
    dialogSvc: {},
    navigate: () => {},
  };
  const ctrl = new ComposerController(host, services, { async refreshSessions() {}, flushStream() {} });
  await ctrl.regenerate();
  assert.equal(api.runTurnCalls.length, 0);
  assert.equal(toasts[0], '没有可重生成的用户消息');
});

test('regenerate 在飞回合时拒绝重入', async () => {
  const { host } = makeHost([{ id: 'u1', type: 'user', payload: { content: '问题' } }]);
  const api = makeApi();
  const gate = deferred();
  api.runTurn = (params) => {
    api.runTurnCalls.push(params);
    return gate.promise;
  };
  const ctrl = makeController(host, api);
  const running = ctrl.send('问题', [], []);
  await ctrl.regenerate();
  assert.equal(api.runTurnCalls.length, 1, '在飞回合期间不得再发一轮');
  gate.resolve({ threadId: 't1' });
  await running;
});

test('editLastUser：把末条用户消息填回输入框（nonce 递增）且不自动发送', () => {
  const { host, state } = makeHost([
    { id: 'u1', type: 'user', payload: { content: '第一条' } },
    { id: 'a1', type: 'assistant', payload: { content: '回复' } },
    { id: 'u2', type: 'user', payload: { content: '第二条' } },
  ]);
  const api = makeApi();
  const ctrl = makeController(host, api);
  ctrl.editLastUser();
  assert.deepEqual(state.composerSeed, { text: '第二条', nonce: 1 });
  ctrl.editLastUser();
  assert.deepEqual(state.composerSeed, { text: '第二条', nonce: 2 }, '同一文本重复回填也要重新触发');
  assert.equal(api.runTurnCalls.length, 0, '仅回填，不自动发送（重发由发送键 / 回车复用 send）');
});

test('editLastUser：无用户消息时仅轻提示', () => {
  const { host, state } = makeHost([{ id: 'a1', type: 'assistant', payload: { content: 'x' } }]);
  const toasts = [];
  const api = makeApi();
  const services = {
    api,
    toast: (m) => toasts.push(m),
    reducers: { appendFinalText: (events) => events },
    stream: {},
    toastSvc: {},
    dialogSvc: {},
    navigate: () => {},
  };
  const ctrl = new ComposerController(host, services, { async refreshSessions() {}, flushStream() {} });
  ctrl.editLastUser();
  assert.equal(state.composerSeed, null, '无用户消息不得写入回填指令');
  assert.equal(toasts[0], '没有可编辑的用户消息');
});

test('SessionController.appendTextDelta：回合结束后到达的迟到增量不残留流式缓冲', async () => {
  // SessionController 经 highlight → deps 读 window（UMD 全局），故先种最小桩再动态加载。
  globalThis.window = globalThis.window ?? { React: { createElement: () => ({}) } };
  const { SessionController } = await import('../dist/ui/controllers/SessionController.js');
  const { host, state } = makeHost([], { busy: true });
  const services = {
    api: {},
    toast: () => {},
    reducers: { appendTextDelta: (cur, text) => cur + text },
    stream: {},
    toastSvc: {},
    dialogSvc: {},
    navigate: () => {},
  };
  const sessions = new SessionController(host, services);
  sessions.appendTextDelta({ text: '进行中' });
  assert.equal(state.streamText, '进行中', '回合进行中必须累积增量');
  // 用户点「停止」后 busy 立即为 false：此后的迟到增量一律丢弃（否则流式卡片会被重新点亮）。
  host.patch({ busy: false, streamText: '' });
  sessions.appendTextDelta({ text: '迟到' });
  assert.equal(state.streamText, '', '回合结束后不得再累积增量');
});
