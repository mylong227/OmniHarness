// 图运行「续跑」的客户端接线契约测试（2026-10-08）。
// 直跑 web/dist（先 npm run web:build 编译），node --test web/test/graphResumeClient.test.mjs。
//
// 为什么单独钉这条：服务端 2026-10-08 新增 graph.resume RPC（从运行存档读回规格、复用已完成步骤），
// 而客户端此前只有 runGraph —— 能发起、不能接着跑。判据同时钉住「方法名 + 参数形状」，
// 避免只加了个名字、参数拼错却没人发现（本仓「声明了但没接线」是最高频缺陷形态）。

import assert from 'node:assert/strict';
import test from 'node:test';

const { ApiClient } = await import('../dist/core/ApiClient.js');

/**
 * 打桩 fetch：记录一次调用并返回给定 JSON-RPC 响应。
 * @param payload 响应体
 * @returns 捕获到的 { url, init }
 */
function stubFetch(payload) {
  const captured = { url: '', init: undefined };
  globalThis.fetch = async (url, init) => {
    captured.url = String(url);
    captured.init = init;
    return { json: async () => payload };
  };
  return captured;
}

test('resumeGraph：走 graph.resume 且参数为 { runId }，返回值原样透出', async () => {
  const cap = stubFetch({
    jsonrpc: '2.0',
    id: 1,
    result: { runId: 'run_abc_1', nodeCount: 2 },
  });
  const res = await new ApiClient().resumeGraph('run_abc_1');

  assert.strictEqual(cap.url, '/rpc');
  const body = JSON.parse(cap.init.body);
  assert.strictEqual(body.method, 'graph.resume');
  assert.deepStrictEqual(body.params, { runId: 'run_abc_1' });
  assert.deepStrictEqual(res, { runId: 'run_abc_1', nodeCount: 2 });
});

test('resumeGraph：服务端报错（存档缺失等）⇒ 错误信息透出，不静默成功', async () => {
  stubFetch({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: '找不到运行日志：/tmp/x/graph-runs/run_nope.jsonl' },
  });
  await assert.rejects(
    () => new ApiClient().resumeGraph('run_nope'),
    /找不到运行日志/,
  );
});
