/**
 * **结构化输出（JSON Schema）**判据（2026-10-11，目标项「结构化输出（JSON Schema）」）。
 *
 * ## 修之前是什么样子
 *
 * `ModelRequest` 里**根本没有**结构化输出的位置 ⇒ 五条通路（OpenAI 兼容 / Responses /
 * Anthropic / Ollama / mock）一律零支持，"让模型吐 JSON"只能靠提示词写"请只输出 JSON"
 * 再由调用方 `JSON.parse` 撞运气。本次补的是**契约字段**（`ModelRequest.responseFormat`），
 * 并把它落到四条上游各自的正确字段上（映射收在 `ModelResponseFormats`，单一实现）。
 *
 * ## 判据口径
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | OpenAI 兼容：`response_format` 三种形态正确，纯文本/缺省**不发该字段** | 旧行为被改（给所有请求带上一个端点不认识的字段 ⇒ 400） |
 * | ② | Responses：走 `text.format`（不是 `response_format`） | 字段名混用 ⇒ 结构化静默失效 |
 * | ③ | Anthropic：注入强制工具 + `tool_choice`，且响应里的**强制** tool_use 转回 JSON 文本、**不进** toolCalls | harness 去执行一个不存在的"工具"，或调用方永远拿不到结构化文本 |
 * | ④ | Ollama：`format` = schema / `'json'` / 不发 | 结构化静默失效 |
 * | ⑤ | mock：按 schema 造出 required 全填的合法 JSON（离线可端到端验证） | 该能力在无 Key 环境里无法被验证 |
 * | ⑥ | 不合规的格式名 **fail-closed**（构造请求体即抛） | 端点在发送后 400，把"配置写错"伪装成"上游故障" |
 * | ⑦ | 单一实现：`'json_schema'` 字面量只许出现在映射模块 | 上游改字段名只会改到其中一两条 |
 *
 * ③ 与 ⑤ 另配**正对照**（真工具不被误伤 / 非结构化时行为不变）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import { ResponsesModel } from '../../src/adapters/model/responsesModel.js';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { ModelResponseFormats } from '../../src/adapters/model/modelResponseFormats.js';
import type { ModelRequest, ModelResponseFormat } from '../../src/ports/model/model.js';

/** 仓库根（判据在 `dist/tests/unit/`，源码按 cwd 读）。 */
const REPO_ROOT = process.cwd();

/** 例子的 JSON Schema（三个字段，两个必填）。 */
const SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    score: { type: 'number' },
    tags: { type: 'array' },
  },
  required: ['title', 'score'],
  additionalProperties: false,
};

/** 基础请求（无工具）。 */
function request(format?: ModelResponseFormat): ModelRequest {
  return {
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '给一条结论' },
    ],
    tools: [],
    ...(format !== undefined ? { responseFormat: format } : {}),
  };
}

/** 临时替换 fetch，并回传捕获到的请求体。 */
async function captureBody<T>(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly body: Record<string, unknown> }> {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return handler(url, init);
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, body };
  } finally {
    globalThis.fetch = original;
  }
}

/** OpenAI 兼容端点的成功响应。 */
async function chatOk(): Promise<Response> {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: '{"title":"t","score":1}' } }] }),
    {
      status: 200,
    },
  );
}

test('① OpenAI 兼容：response_format 三态正确，且纯文本/缺省**不发该字段**', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-x',
  });
  const schemaFormat: ModelResponseFormat = {
    kind: 'json-schema',
    name: 'conclusion',
    schema: SCHEMA,
    strict: true,
  };
  const withSchema = await captureBody(chatOk, () => model.generate(request(schemaFormat)));
  assert.deepStrictEqual(withSchema.body['response_format'], {
    type: 'json_schema',
    json_schema: { name: 'conclusion', schema: SCHEMA, strict: true },
  });

  const objectFormat = await captureBody(chatOk, () =>
    model.generate(request({ kind: 'json-object' })),
  );
  assert.deepStrictEqual(objectFormat.body['response_format'], { type: 'json_object' });

  // **旧行为不变**：纯文本与缺省都不得出现该字段（多带一个端点不认识的字段会 400）。
  for (const [label, fmt] of [
    ['显式 text', { kind: 'text' } as ModelResponseFormat],
    ['缺省', undefined],
  ] as const) {
    const plain = await captureBody(chatOk, () => model.generate(request(fmt)));
    assert.strictEqual(
      'response_format' in plain.body,
      false,
      `${label} 请求不得带 response_format（旧行为逐字不变）`,
    );
  }
});

test('② Responses API：走 text.format（**不是** response_format）', async () => {
  const model = new ResponsesModel({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-5',
    store: false,
  });
  const format: ModelResponseFormat = { kind: 'json-schema', name: 'conclusion', schema: SCHEMA };
  const { body } = await captureBody(
    async () =>
      new Response(JSON.stringify({ output_text: '{"title":"t","score":1}' }), { status: 200 }),
    () => model.generate(request(format)),
  );
  assert.deepStrictEqual(body['text'], {
    format: { type: 'json_schema', name: 'conclusion', schema: SCHEMA },
  });
  assert.strictEqual('response_format' in body, false, 'Responses 通路不得用 Chat 的字段名');
});

test('③ Anthropic：注入强制工具；强制 tool_use 转回 JSON 文本且不进 toolCalls', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    model: 'claude-x',
  });
  const format: ModelResponseFormat = { kind: 'json-schema', name: 'conclusion', schema: SCHEMA };
  const { body, result } = await captureBody(
    async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: 'text', text: '前置说明' },
            {
              type: 'tool_use',
              id: 'forced_1',
              name: 'conclusion',
              input: { title: 't', score: 2 },
            },
          ],
        }),
        { status: 200 },
      ),
    () => model.generate(request(format)),
  );

  // 请求侧：schema 变成工具 + 强制选择。
  const tools = body['tools'] as { name: string; input_schema: unknown }[];
  assert.strictEqual(tools.length, 1, '未传用户工具时 tools 里应恰好只有那个强制工具');
  assert.strictEqual(tools[0]?.name, 'conclusion');
  assert.deepStrictEqual(tools[0]?.input_schema, SCHEMA);
  assert.deepStrictEqual(body['tool_choice'], { type: 'tool', name: 'conclusion' });

  // 响应侧：强制工具的输出必须成为**文本**（可 JSON.parse），且不得留在 toolCalls 里。
  assert.strictEqual(result.toolCalls, undefined, '强制工具不得被当成待执行工具');
  assert.ok(result.text !== undefined, '必须给出文本');
  assert.match(result.text, /前置说明/, '原有文本块不得丢');
  const json = JSON.stringify({ title: 't', score: 2 });
  assert.ok(result.text.includes(json), `文本里应含该 JSON：${result.text}`);
  assert.deepStrictEqual(JSON.parse(json), { title: 't', score: 2 });
});

test('③-正对照：非结构化的**真工具调用**不得被误伤', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk',
    model: 'claude-x',
  });
  const { result } = await captureBody(
    async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls' } }],
        }),
        { status: 200 },
      ),
    () => model.generate(request()),
  );
  assert.strictEqual(result.toolCalls?.length, 1, '没有 responseFormat 时真工具调用必须照旧透出');
  assert.strictEqual(result.toolCalls?.[0]?.name, 'shell');
});

test('④ Ollama（llama.cpp 通路）：format = schema / "json" / 不发', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen-local' });
  const schemaFormat: ModelResponseFormat = { kind: 'json-schema', name: 'c', schema: SCHEMA };
  const withSchema = await captureBody(
    async () => new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200 }),
    () => model.generate(request(schemaFormat)),
  );
  assert.deepStrictEqual(withSchema.body['format'], SCHEMA);
  const objectFormat = await captureBody(
    async () => new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200 }),
    () => model.generate(request({ kind: 'json-object' })),
  );
  assert.strictEqual(objectFormat.body['format'], 'json');
  const plain = await captureBody(
    async () => new Response(JSON.stringify({ message: { content: 'hi' } }), { status: 200 }),
    () => model.generate(request()),
  );
  assert.strictEqual('format' in plain.body, false, '纯文本不得带 format');
});

test('⑤ mock：按 schema 造出 required 全填的合法 JSON（离线可端到端验证）', async () => {
  const model = new MockModel();
  const withSchema = await model.generate(
    request({ kind: 'json-schema', name: 'conclusion', schema: SCHEMA }),
  );
  assert.strictEqual(withSchema.toolCalls, undefined, '结构化请求不得先返回工具脚本');
  const parsed = JSON.parse(String(withSchema.text)) as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['score', 'title'], 'required 字段必须全填');
  assert.strictEqual(typeof parsed['title'], 'string');
  assert.strictEqual(typeof parsed['score'], 'number');

  const objectFormat = await model.generate(request({ kind: 'json-object' }));
  assert.deepStrictEqual(JSON.parse(String(objectFormat.text)), { mock: true });
});

test('⑤-正对照：非结构化时 mock 仍走原脚本（首轮工具调用 + 次轮终局文本）', async () => {
  const model = new MockModel();
  const first = await model.generate(request());
  assert.strictEqual(first.toolCalls?.[0]?.name, 'shell', '旧行为必须逐字保留');
  // 第二轮（同一实例）：不再返回工具调用，而是收尾文本——这条路径是"工具回路能结束"的判据。
  const second = await model.generate(request());
  assert.strictEqual(second.toolCalls, undefined, '第二轮不得再要工具');
  assert.match(String(second.text), /任务完成/u);
});

test('⑤-b mock 的占位值覆盖各 JSON 类型；`required` 缺席时填全部 properties', async () => {
  const allTypes: Readonly<Record<string, unknown>> = {
    type: 'object',
    properties: {
      s: { type: 'string' },
      n: { type: 'integer' },
      b: { type: 'boolean' },
      a: { type: 'array' },
      o: { type: 'object' },
      weird: {}, // 未声明 type ⇒ 占位 null（而不是编造一个值）
    },
    required: ['s', 'n', 'b', 'a', 'o', 'weird'],
  };
  const model = new MockModel();
  const out = await model.generate(request({ kind: 'json-schema', name: 'all', schema: allTypes }));
  const parsed = JSON.parse(String(out.text)) as Record<string, unknown>;
  assert.deepStrictEqual(parsed, { s: 'mock', n: 0, b: false, a: [], o: {}, weird: null });

  // `required` 缺席 ⇒ 按 properties 全填（否则模型拿到的 JSON 少字段，调用方 schema 校验会炸）。
  const noRequired = new MockModel();
  const out2 = await noRequired.generate(
    request({
      kind: 'json-schema',
      name: 'noreq',
      schema: { type: 'object', properties: { only: { type: 'string' } } },
    }),
  );
  assert.deepStrictEqual(JSON.parse(String(out2.text)), { only: 'mock' });

  // schema 没有 properties ⇒ 空对象（而不是抛错）。
  const emptySchema = new MockModel();
  const out3 = await emptySchema.generate(
    request({ kind: 'json-schema', name: 'empty', schema: { type: 'object' } }),
  );
  assert.deepStrictEqual(JSON.parse(String(out3.text)), {});
});

test('⑤-c mock 的工具脚本只在"末条非 system 消息是 user"时触发', async () => {
  const model = new MockModel();
  const withAssistantLast: ModelRequest = {
    messages: [
      { role: 'user', content: '先前的问题' },
      { role: 'assistant', content: '先前的回答' },
    ],
    tools: [],
  };
  const out = await model.generate(withAssistantLast);
  assert.strictEqual(
    out.toolCalls,
    undefined,
    '末条非 system 消息是 assistant 时不得发起工具调用（否则工具回路会自我循环）',
  );
  assert.match(String(out.text), /任务完成/u);
});

test('⑥ fail-closed：不合规的格式名在**构造请求体**时即抛（不留给端点 400）', () => {
  const bad: ModelResponseFormat = { kind: 'json-schema', name: 'bad name!', schema: SCHEMA };
  assert.throws(() => ModelResponseFormats.toOpenAiChat(bad), /不合规/u);
  assert.throws(() => ModelResponseFormats.toResponsesText(bad), /不合规/u);
  // 正对照：合规名不得抛（否则⑥可能只是"什么都抛"）。
  assert.doesNotThrow(() =>
    ModelResponseFormats.toOpenAiChat({ kind: 'json-schema', name: 'ok_name-1', schema: SCHEMA }),
  );
});

test('⑦ 单一实现：上游字段字面量只许出现在映射模块（防各适配器各写一遍）', () => {
  const mapping = readFileSync(
    join(REPO_ROOT, 'src/adapters/model/modelResponseFormats.ts'),
    'utf8',
  );
  assert.match(mapping, /'json_schema'/u, '映射模块必须自己持有 json_schema 字面量');
  for (const file of ['anthropicModel', 'llamaCppModel', 'mockModel']) {
    const source = readFileSync(join(REPO_ROOT, `src/adapters/model/${file}.ts`), 'utf8');
    assert.doesNotMatch(
      source,
      /'json_schema'/u,
      `${file}.ts 不得自持上游字段字面量 ⇒ 应改用 ModelResponseFormats`,
    );
  }
});
