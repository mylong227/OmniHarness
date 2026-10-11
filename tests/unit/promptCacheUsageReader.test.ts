/**
 * 提示缓存命中量读取器判据（A2，2026-10-11）。
 *
 * ## 为什么补它
 *
 * `PromptCacheUsageReader` 的三个读取路径（OpenAI 兼容 / Responses / Anthropic）此前**零判据**：
 * 全仓只在召回夹具里以"锚点字符串"提到过它，没有任何测试调用。而它的输出直接喂给
 * 缓存命中率、P5 成本折抵与成本护栏——读取一旦悄悄退化（例如把"没这个字段"算成 0），
 * 三处下游数字会**整体偏低**而无人发现。
 *
 * ## 判据口径（钉住"什么必须成立"）
 *
 * ① 三家的字段名与嵌套层级各自正确；② OpenAI 兼容的两条字段有**优先序**（details 优先）；
 * ③ Anthropic 的 `cache_creation_input_tokens`（**写**缓存）**不得**被当成命中；
 * ④ 最容易被"顺手优化"掉的一条：**「没这个字段」与「确实是 0」语义不同**，前者必须返回
 * `undefined`、后者必须返回 `0`；⑤ 畸形输入一律 fail-soft；⑥⑦ 两条**接线自证**：
 * 真实适配器（stub fetch）必须把命中量填进 `ModelUsage`，否则"读取器有判据"只是自娱自乐。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptCacheUsageReader } from '../../src/adapters/model/promptCacheUsageReader.js';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import type { ModelRequest } from '../../src/ports/model/model.js';

/** 最小合法请求（适配器只要求 messages/tools 存在）。 */
const REQUEST: ModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

/**
 * 用桩 `fetch` 跑一段断言，结束后恢复原实现。
 *
 * 为什么不用本地 HTTP 端点（本仓 `openAiImageAttachment.test.ts` 那种）：那是**真 socket**，
 * 并行全量跑时会出现「绑上了却连不上」的基建竞态（该文件自己记过）。本判据只关心
 * 适配器如何**解读响应体**，桩 fetch 即可，且确定性更好。
 * @param body 端点将返回的 JSON 体。
 * @param fn 断言体。
 * @returns 无返回值。
 */
async function withJsonResponse(body: unknown, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('① OpenAI 兼容：details 优先，回退 DeepSeek 风格字段', () => {
  const reader = new PromptCacheUsageReader();
  assert.strictEqual(
    reader.readOpenAiCompatible({ prompt_tokens_details: { cached_tokens: 40 } }),
    40,
  );
  assert.strictEqual(reader.readOpenAiCompatible({ prompt_cache_hit_tokens: 30 }), 30);
  // 两个字段同时存在 ⇒ 取 details（OpenAI 官方形态优先，DeepSeek 字段只是回退）
  assert.strictEqual(
    reader.readOpenAiCompatible({
      prompt_tokens_details: { cached_tokens: 40 },
      prompt_cache_hit_tokens: 30,
    }),
    40,
  );
  // details 存在但其中字段缺失 / 非法 ⇒ 必须回退到另一个字段，而不是直接判"未知"
  assert.strictEqual(
    reader.readOpenAiCompatible({
      prompt_tokens_details: { cached_tokens: null },
      prompt_cache_hit_tokens: 30,
    }),
    30,
  );
});

test('② Responses：只认 input_tokens_details.cached_tokens', () => {
  const reader = new PromptCacheUsageReader();
  assert.strictEqual(reader.readResponses({ input_tokens_details: { cached_tokens: 12 } }), 12);
  // 不得借用 OpenAI 兼容路径的字段名（两家嵌套层级不同）
  assert.strictEqual(
    reader.readResponses({ prompt_tokens_details: { cached_tokens: 12 } }),
    undefined,
  );
});

test('③ Anthropic：只取 cache_read_input_tokens，写缓存不得算成命中', () => {
  const reader = new PromptCacheUsageReader();
  assert.strictEqual(reader.readAnthropic({ cache_read_input_tokens: 7 }), 7);
  assert.strictEqual(
    reader.readAnthropic({ cache_creation_input_tokens: 99 }),
    undefined,
    'cache_creation 是**写**入缓存，语义与命中相反 ⇒ 不得计入命中量',
  );
  assert.strictEqual(
    reader.readAnthropic({ cache_read_input_tokens: 7, cache_creation_input_tokens: 99 }),
    7,
  );
});

test('④ 「没这个字段」与「确实是 0」必须可区分（本类存在的理由）', () => {
  const reader = new PromptCacheUsageReader();
  assert.strictEqual(
    reader.readOpenAiCompatible({ prompt_tokens: 100 }),
    undefined,
    '端点没上报缓存字段 ⇒ 未知（undefined），不是 0',
  );
  assert.strictEqual(
    reader.readOpenAiCompatible({ prompt_tokens_details: { cached_tokens: 0 } }),
    0,
    '显式上报 0 ⇒ 是"确实一次都没命中"的有效观测，必须是 0 而不是 undefined',
  );
});

test('⑤ 畸形输入一律 fail-soft 到 undefined（不抛错、不臆造）', () => {
  const reader = new PromptCacheUsageReader();
  for (const raw of [null, undefined, 'x', 42, [], { prompt_tokens_details: 'x' }]) {
    assert.strictEqual(reader.readOpenAiCompatible(raw), undefined, `raw=${JSON.stringify(raw)}`);
    assert.strictEqual(reader.readResponses(raw), undefined);
    assert.strictEqual(reader.readAnthropic(raw), undefined);
  }
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '40', {}]) {
    assert.strictEqual(
      reader.readAnthropic({ cache_read_input_tokens: bad }),
      undefined,
      `非法命中量 ${JSON.stringify(bad)} ⇒ undefined`,
    );
  }
  // 合法小数按四舍五入收成整数（端点上出现过 40.4 这类形态）
  assert.strictEqual(reader.readAnthropic({ cache_read_input_tokens: 40.4 }), 40);
});

test('⑥ 接线自证 · OpenAI 兼容：真实适配器把命中量填进 ModelUsage', async () => {
  const model = new OpenAiCompatibleModel({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'k',
    model: 'stub',
  });
  await withJsonResponse(
    {
      choices: [{ message: { content: 'ok' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    },
    async () => {
      const out = await model.generate(REQUEST);
      assert.strictEqual(out.usage?.cachedPromptTokens, 40);
      assert.strictEqual(out.usage?.promptTokens, 100);
    },
  );
  // 反面对照：端点**没上报**缓存字段时必须留 undefined（写成 0 会系统性拉低平均命中率）。
  await withJsonResponse(
    {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    },
    async () => {
      const out = await model.generate(REQUEST);
      assert.strictEqual(out.usage?.cachedPromptTokens, undefined);
    },
  );
});

test('⑦ 接线自证 · Anthropic：promptTokens = input + 写缓存 + 读缓存（跨厂商可比）', async () => {
  const model = new AnthropicModel({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'k',
    model: 'stub',
  });
  await withJsonResponse(
    {
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 3,
      },
    },
    async () => {
      const out = await model.generate(REQUEST);
      assert.strictEqual(
        out.usage?.cachedPromptTokens,
        7,
        'Anthropic 的命中量必须只取 cache_read_input_tokens',
      );
      assert.strictEqual(
        out.usage?.promptTokens,
        20,
        'Anthropic 的 input_tokens 不含缓存两段 ⇒ promptTokens 必须补上（否则跨厂商比"输入规模"时系统性偏低）',
      );
    },
  );
});
