/**
 * 单次输出上限（`ModelRequest.maxOutputTokens`）透传判据。
 *
 * 为什么需要：长会话里一次思考生成 20k token 是真实成本（2026-10-19 鹈鹕会话首调 20,193
 * completion token）。`OMNI_MAX_OUTPUT_TOKENS` 是运维侧的硬上界，必须在 wire 层真的变成
 * `max_tokens`；只写配置不接线等于没有。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.ts';

test('OpenAI 兼容适配器：maxOutputTokens 透传为 max_tokens，未设时不发', async () => {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    await model.generate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 1234,
    });
    assert.strictEqual(bodies[0]?.['max_tokens'], 1234, '必须透传为 max_tokens');

    await model.generate({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(bodies[1] ?? {}, 'max_tokens'),
      false,
      '未配置上限时不得发 max_tokens（保留端点默认）',
    );
  } finally {
    globalThis.fetch = original;
  }
});
