// F6 diff accept/reject 闭环：前端接线契约测试。
// 验证 ApiClient 的 stageFile / revertFile / stageHunk / revertHunk 调用正确的 changes.* RPC，
// 坐实「hunk / 文件级接受（stage）与拒绝（revert）联动真实写入」已闭环（后端 RPC + ChangesTab 调用齐备）。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';

const { ApiClient } = await import('../dist/core/ApiClient.js');

/** 捕获一次 RPC 调用（method + params）。 */
async function captureRpc(fn) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }) };
  };
  const api = new ApiClient();
  const res = await fn(api);
  const body = JSON.parse(calls[0].init.body);
  return { calls, body, res };
}

test('stageFile 调用 changes.stageFile RPC', async () => {
  const { body, res } = await captureRpc((api) => api.stageFile('src/app.ts'));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.stageFile');
  assert.deepEqual(body.params, { path: 'src/app.ts' });
});

test('revertFile 调用 changes.revertFile RPC', async () => {
  const { body, res } = await captureRpc((api) => api.revertFile('src/app.ts'));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.revertFile');
  assert.deepEqual(body.params, { path: 'src/app.ts' });
});

test('stageHunk 调用 changes.stageHunk RPC（含 hunk 与 isNew）', async () => {
  const { body, res } = await captureRpc((api) => api.stageHunk('src/app.ts', '@@ -1,3 +1,3 @@', true));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.stageHunk');
  assert.deepEqual(body.params, { path: 'src/app.ts', hunk: '@@ -1,3 +1,3 @@', isNew: true });
});

test('revertHunk 调用 changes.revertHunk RPC（含 hunk）', async () => {
  const { body, res } = await captureRpc((api) => api.revertHunk('src/app.ts', '@@ -1,3 +1,3 @@'));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.revertHunk');
  assert.deepEqual(body.params, { path: 'src/app.ts', hunk: '@@ -1,3 +1,3 @@' });
});
