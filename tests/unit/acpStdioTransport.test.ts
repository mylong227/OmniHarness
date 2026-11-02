// ACP stdio 传输判据（换行分隔 JSON-RPC）：此前 acpStdioTransport 覆盖率 3.77%，
// 只有「被 AcpServer 间接 import」的那几行被执行过。
//
// 这里用真 `PassThrough` 流验证传输契约：
// ① 订阅前的消息按序回放；空行 / 非 JSON / 非 JSON-RPC 结构丢弃（不向 stdout 报错）；
// ② send 只写 stdout，每条一行 JSON；closed 后不再写；
// ③ close 触发一次 onClose，且关闭后注册的 onClose 走微任务；
// ④ 重复 close 幂等。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { AcpStdioTransport } from '../../src/acp/acpStdioTransport.ts';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';

/** 造一对内存流与传输。 */
function setup(): {
  input: PassThrough;
  output: PassThrough;
  transport: AcpStdioTransport;
  written: string[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  return { input, output, transport: new AcpStdioTransport(input, output), written };
}

/** 等 readline 把已写入的行派发完。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test('① 订阅前缓冲并按序回放；空行 / 坏 JSON / 非 JSON-RPC 丢弃', async () => {
  const { input, transport } = setup();
  const first = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
  const second = '{"jsonrpc":"2.0","method":"session/update","params":{}}';
  input.write(`${first}\n\n不是 JSON\n{"foo":1}\n${second}\n`);
  await flush();
  const got: RpcMessage[] = [];
  transport.onMessage((message) => got.push(message));
  assert.strictEqual(got.length, 2, '只回放两条合法 JSON-RPC 消息');
  assert.deepStrictEqual(got[0], JSON.parse(first));
  assert.deepStrictEqual(got[1], JSON.parse(second));
});

test('② send 每条一行 JSON；关闭后不再写', async () => {
  const { output, transport, written } = setup();
  transport.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: {} } as RpcMessage);
  await flush();
  assert.strictEqual(written.length, 1);
  assert.ok(written[0]?.endsWith('\n'), '必须以换行结尾');
  assert.deepStrictEqual(JSON.parse(written[0] as string), {
    jsonrpc: '2.0',
    id: 7,
    method: 'session/prompt',
    params: {},
  });
  transport.close();
  transport.send({ jsonrpc: '2.0', method: 'x' } as RpcMessage);
  await flush();
  assert.strictEqual(written.length, 1, '关闭后 send 必须静默丢弃');
  assert.strictEqual(output.writableEnded, false, '传输 close 不应直接结束外部 output 流');
});

test('③ close 只触发一次 onClose；关闭后注册的回调走微任务', async () => {
  const { input, transport } = setup();
  let hits = 0;
  transport.onClose(() => {
    hits += 1;
  });
  transport.close();
  input.end();
  assert.strictEqual(hits, 1, '关闭回调只触发一次');
  let late = false;
  transport.onClose(() => {
    late = true;
  });
  assert.strictEqual(late, false, '关闭后注册必须异步触发');
  await Promise.resolve();
  assert.strictEqual(late, true, '关闭后注册的 onClose 应在微任务内触发');
  transport.close();
  assert.strictEqual(hits, 1, '重复 close 幂等');
});

test('④ 入站流关闭（EOF）也触发 onClose（编辑器断开路径）', async () => {
  const { input, transport } = setup();
  let closed = false;
  transport.onClose(() => {
    closed = true;
  });
  input.end();
  await flush();
  assert.strictEqual(closed, true);
});
