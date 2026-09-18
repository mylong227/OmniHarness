// F4 中断 / 重生成 / 编辑重发：前端接线契约测试。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';

const { ApiClient } = await import('../dist/core/ApiClient.js');
const { ComposerController } = await import('../dist/ui/controllers/ComposerController.js');

/** 构造最小可控的 ComposerController（host/services/sessions 全 mock）。 */
function makeController(events) {
  const host = {
    patch() {},
    getState() {
      return { events, currentThreadId: 't1', sessions: [], streamText: '', finalizedStreamText: '' };
    },
  };
  const api = {
    runTurnCalls: [],
    aborted: false,
    async runTurn(params) {
      this.runTurnCalls.push(params);
      return { threadId: 't1' };
    },
    abortTurn() {
      this.aborted = true;
      return Promise.resolve({ ok: true });
    },
  };
  const services = {
    api,
    toast() {},
    reducers: { appendFinalText: (e) => e },
    stream: {},
    toastSvc: {},
    dialogSvc: {},
  };
  const sessions = { async refreshSessions() {} };
  return { ctrl: new ComposerController(host, services, sessions), api };
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

test('stop 触发后端中断', () => {
  const { ctrl, api } = makeController([]);
  ctrl.stop();
  assert.equal(api.aborted, true);
});

test('regenerate 取最后一条用户消息重发', async () => {
  const events = [
    { id: 'u1', type: 'user', payload: { content: '第一条' } },
    { id: 'a1', type: 'assistant', payload: { content: '回复1' } },
    { id: 'u2', type: 'user', payload: { content: '第二条' } },
  ];
  const { ctrl, api } = makeController(events);
  await ctrl.regenerate();
  assert.equal(api.runTurnCalls.length, 1);
  assert.equal(api.runTurnCalls[0].prompt, '第二条');
  assert.equal(api.runTurnCalls[0].threadId, 't1');
});

test('regenerate 无用户消息时仅轻提示、不发起请求', async () => {
  const toasts = [];
  const host = {
    patch() {},
    getState() {
      return { events: [{ id: 'a1', type: 'assistant', payload: { content: 'x' } }], currentThreadId: 't1', sessions: [], streamText: '', finalizedStreamText: '' };
    },
  };
  const api = { runTurnCalls: [], async runTurn() { return { threadId: 't1' }; }, abortTurn: () => Promise.resolve({ ok: true }) };
  const services = { api, toast: (m) => toasts.push(m), reducers: { appendFinalText: (e) => e }, stream: {}, toastSvc: {}, dialogSvc: {} };
  const ctrl = new ComposerController(host, services, { async refreshSessions() {} });
  await ctrl.regenerate();
  assert.equal(api.runTurnCalls.length, 0);
  assert.equal(toasts[0], '没有可重生成的用户消息');
});

test('resend 把编辑文本作为新回合发送', async () => {
  const { ctrl, api } = makeController([]);
  await ctrl.resend('改后的问题');
  assert.equal(api.runTurnCalls.length, 1);
  assert.equal(api.runTurnCalls[0].prompt, '改后的问题');
  assert.equal(api.runTurnCalls[0].threadId, 't1');
});
