/**
 * A2A 网络端口加固实测（对应全项目审计发现的「无界请求体」缺口）。
 *
 * 修复前 `HttpA2aServerTransport.listen` 的入站处理器用 `body += chunk` 累积请求体，
 * **既无体积上限也无读超时**——对端（不可信）可借超大/慢速请求耗尽内存或长期占用连接。
 * 修复后：超过 `MAX_BODY_BYTES` 即 413 并销毁连接；读超时释放连接；正常小请求不受影响。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpA2aServerTransport } from '../../src/a2a/index.js';

/** 拉起一个真实 A2A HTTP 服务端（随机端口）。 */
async function startServer(): Promise<{ port: number; close: () => void }> {
  const server = new HttpA2aServerTransport();
  const port = await server.listen(0);
  return { port, close: () => server.close() };
}

test('A2A HTTP 服务端：请求体超过上限即 413（fail-closed，不累积到内存耗尽）', async () => {
  const { port, close } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(2 * 1024 * 1024, 0x20), // 2 MiB 空格：稳定越过 1 MiB 上限
    });
    assert.strictEqual(res.status, 413, `超体积请求必须被拒（实际 ${res.status}）`);
  } finally {
    close();
  }
});

test('A2A HTTP 服务端：未超体积的小请求仍走正常解析（上限不误伤正常流量）', async () => {
  const { port, close } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    });
    // 体积未超上限 ⇒ 进入 JSON-RPC 解析；非法报文返回 400（而非 413），
    // 证明体积上限只拦截溢出，不影响正常小请求的解析路径。
    assert.strictEqual(res.status, 400, `正常小请求应走解析（实际 ${res.status}）`);
  } finally {
    close();
  }
});
