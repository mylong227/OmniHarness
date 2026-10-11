/**
 * 本地模型（Ollama / llama.cpp 原生）HTTP 错误分类判据（A3，2026-10-11）。
 *
 * ## 为什么补它
 *
 * `LlamaCppModel.httpError` 此前自己写了一份窄口径：`status === 429 || 5xx`，
 * 于是 **408（请求超时）与 409（冲突）被判"不可重试"**，而同一仓的共享口径
 * `ModelHttpErrors.retryableOf` 明确把两者算可重试（OpenAI 兼容 / Anthropic / Responses
 * 三条通路都走共享口径）。后果是**本地通路上游偶发抖动即整回合炸掉**，而重试层在场却不生效。
 * 现改为直接复用共享映射器（顺带获得 `Retry-After` 解析与响应体落日志）。
 *
 * ## 判据有区分力的自证
 *
 * 用例③把**旧口径**（`429 || 5xx`）当场算一遍并断言它对 408/409 判 false——
 * 即本文件在改动前必红。这不是装饰：它防止将来有人把分类"简化"回窄口径而无人发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.js';
import { ModelHttpErrors } from '../../src/adapters/model/modelHttpErrors.js';
import type { ModelRequest } from '../../src/ports/model/model.js';

/** 最小合法请求（适配器只要求 messages/tools 存在）。 */
const REQUEST: ModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

/**
 * 用桩 `fetch` 返回一个非 2xx 响应，跑一段断言后恢复原实现。
 * @param status HTTP 状态码。
 * @param headers 附加响应头。
 * @param fn 断言体。
 * @returns 无返回值。
 */
async function withErrorResponse(
  status: number,
  headers: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response('{"error":"stub"}', {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    )) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * 捕获 `generate()` 抛出的错误对象（断言其结构化字段）。
 * @param model 被测适配器。
 * @returns 抛出的错误（未抛出则判失败）。
 */
async function errorOf(model: LlamaCppModel): Promise<{
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
}> {
  try {
    await model.generate(REQUEST);
  } catch (error) {
    return error as { status?: number; retryable: boolean; retryAfterMs?: number; message: string };
  }
  throw new Error('预期 generate() 抛错，但它成功了');
}

test('① 408 / 409 必须与共享口径一致地判为可重试（旧实现判 false）', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://127.0.0.1:1', model: 'stub' });
  for (const status of [408, 409, 429, 500, 503]) {
    await withErrorResponse(status, {}, async () => {
      const err = await errorOf(model);
      assert.strictEqual(err.status, status);
      assert.strictEqual(
        err.retryable,
        ModelHttpErrors.retryableOf(status),
        `HTTP ${String(status)} 的可重试判定必须由共享口径给出`,
      );
      assert.strictEqual(err.retryable, true, `HTTP ${String(status)} 应可重试`);
    });
  }
});

test('② 4xx 里的确定性失败不得标可重试（不过度收紧）', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://127.0.0.1:1', model: 'stub' });
  for (const status of [400, 401, 403, 404, 422]) {
    await withErrorResponse(status, {}, async () => {
      const err = await errorOf(model);
      assert.strictEqual(err.retryable, false, `HTTP ${String(status)} 是确定性失败，不该重试`);
    });
  }
});

test('③ 区分力自证：旧口径对 408/409 判 false ⇒ 本判据在改动前必红', () => {
  // 旧实现逐字：`const retryable = status === 429 || (status >= 500 && status <= 599);`
  const legacyRetryable = (status: number): boolean =>
    status === 429 || (status >= 500 && status <= 599);
  assert.strictEqual(legacyRetryable(408), false, '旧口径确实把 408 判为不可重试');
  assert.strictEqual(legacyRetryable(409), false, '旧口径确实把 409 判为不可重试');
  assert.strictEqual(ModelHttpErrors.retryableOf(408), true);
  assert.strictEqual(ModelHttpErrors.retryableOf(409), true);
});

test('④ 复用共享映射器后必须同时拿到 Retry-After 与可定位的消息', async () => {
  const model = new LlamaCppModel({ baseUrl: 'http://127.0.0.1:1', model: 'stub' });
  await withErrorResponse(429, { 'retry-after': '2' }, async () => {
    const err = await errorOf(model);
    assert.strictEqual(err.retryAfterMs, 2000, 'Retry-After 秒数形态应折算为毫秒');
    assert.ok(
      err.message.includes('HTTP 429') && err.message.includes('本地模型请求失败'),
      `消息应同时带前缀与状态码，实为：${err.message}`,
    );
  });
});
