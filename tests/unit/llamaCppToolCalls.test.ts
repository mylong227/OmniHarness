/**
 * 本地模型（Ollama / llama.cpp 原生 `/api/chat`）流式工具调用合单单测。
 *
 * 清偿 `PROJECT_BOARD §3-4`（Ollama 流式工具调用按函数名合并）：同批同名并行调用被吞并、
 * 参数片段后到覆盖。本文件用**脚本化 NDJSON 响应**（stub `globalThis.fetch`）钉住三条判据：
 *   ① 有 `index` 时按槽位分桶 ⇒ 同名并行调用不互相覆盖，且 id 唯一（配对键不得重复）；
 *   ② 字符串型 arguments 按**片段累积**、流末只解析一次 ⇒ 分片 JSON 不再退化成空参数；
 *   ③ 无 `index` 时保持按名合并的既有行为（无真实样本不推断该形态的并行语义）。
 *
 * 诚实边界：本机无 ollama 后端，响应样本是**按协议文档构造**的，不是抓包实录；
 * 故只钉「两种 wire 形态都成立」的改进，不发明协议语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.js';
import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  StreamCallbacks,
} from '../../src/ports/model/model.js';

/** 最小请求（本适配器只读 messages / tools）。 */
function request(): ModelRequest {
  return { messages: [{ role: 'user', content: 'hi' }], tools: [] };
}

/** 无操作流式回调。 */
const callbacks: StreamCallbacks = { onText: () => undefined };

/**
 * 在 stub 掉的 fetch 下跑一次流式请求。
 * @param chunks 逐条 NDJSON 对象（按顺序下发，自动补换行）。
 * @param run 被测调用（在 fetch 已替换的作用域内执行）。
 * @returns run 的返回值（保证 finally 复原 fetch）。
 */
async function withNdjson<T>(chunks: readonly unknown[], run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const body = `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`;
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    })) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** 模型实例（端点不会真的被访问，fetch 已被 stub）。 */
function model(): ModelPort {
  return new LlamaCppModel({ baseUrl: 'http://127.0.0.1:1', model: 'probe' });
}

/** 跑一次流式并断言拿到了工具调用。 */
async function streamTools(chunks: readonly unknown[]): Promise<ModelOutput> {
  return withNdjson(chunks, () => model().stream!(request(), callbacks));
}

test('① 有 index：同名并行调用按槽位分桶，id 唯一且参数各归各位', async () => {
  const out = await streamTools([
    {
      message: {
        tool_calls: [
          { index: 0, function: { name: 'read_file', arguments: { path: 'a.ts' } } },
          { index: 1, function: { name: 'read_file', arguments: { path: 'b.ts' } } },
        ],
      },
    },
    { done: true },
  ]);
  const calls = out.toolCalls ?? [];
  assert.strictEqual(calls.length, 2, '两次同名调用不得被吞并成一条（旧实现只留一条）');
  assert.deepStrictEqual(
    calls.map((call) => call.arguments['path']),
    ['a.ts', 'b.ts'],
    '参数不得互相覆盖',
  );
  assert.strictEqual(new Set(calls.map((call) => call.id)).size, 2, 'id 是配对键，必须唯一');
  assert.deepStrictEqual(
    calls.map((call) => call.id),
    ['read_file', 'read_file#2'],
    'id 合成口径：首个保持裸名，后续同名加序号',
  );
});

test('② 字符串参数分片到达：累积后只解析一次（旧实现片片解析失败 → 空参数）', async () => {
  const out = await streamTools([
    {
      message: {
        tool_calls: [{ index: 0, function: { name: 'write_file', arguments: '{"path":"a' } }],
      },
    },
    {
      message: {
        tool_calls: [
          { index: 0, function: { name: 'write_file', arguments: '.ts","content":"x"}' } },
        ],
      },
    },
    { done: true },
  ]);
  const calls = out.toolCalls ?? [];
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(
    calls[0]?.arguments,
    { path: 'a.ts', content: 'x' },
    '分片必须拼接后再解析；逐片解析会把调用退化成空参数',
  );
});

test('③ 无 index：保持按名合并的既有行为（无真实样本不推断并行语义）', async () => {
  const out = await streamTools([
    {
      message: { tool_calls: [{ function: { name: 'shell', arguments: { command: 'echo 1' } } }] },
    },
    {
      message: { tool_calls: [{ function: { name: 'shell', arguments: { command: 'echo 2' } } }] },
    },
    { done: true },
  ]);
  const calls = out.toolCalls ?? [];
  assert.strictEqual(calls.length, 1, '无 index 时按名合并（旧行为，如实保留）');
  assert.deepStrictEqual(calls[0]?.arguments, { command: 'echo 2' }, '后到覆盖');
});

test('④ 非流式路径：同批同名调用的 id 也唯一', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        message: {
          tool_calls: [
            { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
            { function: { name: 'read_file', arguments: { path: 'b.ts' } } },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
  try {
    const out = await model().generate(request());
    const calls = out.toolCalls ?? [];
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(new Set(calls.map((call) => call.id)).size, 2, 'id 必须唯一');
  } finally {
    globalThis.fetch = original;
  }
});

test('⑤ 非法参数 JSON 仍 fail-soft 回退空对象（不因修复而变严）', async () => {
  const out = await streamTools([
    {
      message: { tool_calls: [{ index: 0, function: { name: 'shell', arguments: '{不是 JSON' } }] },
    },
    { done: true },
  ]);
  assert.deepStrictEqual(out.toolCalls?.[0]?.arguments, {});
});
