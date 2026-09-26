/**
 * 四个模型适配器的**空闲超时**统一回归（2026-09-26 稳定性审计 S2）。
 *
 * 缺陷现场：`RequestStallGuard` 早已落地，但只接在 `OpenAiCompatibleModel` 一条路上——
 * Anthropic / Responses / llama.cpp 三个适配器仍是裸 `fetch`。服务端接受 TCP 后不回包时
 * `fetch` 永不 settle（既不 resolve 也不 reject），而 `RetryingModel` **只对抛出的错误重试**
 * ⇒ 重试永不触发，整条 agent 循环无限期挂死。
 *
 * 本用例用一个「永远不回包、只在 signal abort 时 reject」的 fetch 桩，对四个适配器逐一带上
 * 空闲阈值，断言：① 请求被有界中止（不是永久挂起）；② 中止被归类为**可重试**的 `ModelCallError`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.js';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import { ResponsesModel } from '../../src/adapters/model/responsesModel.js';
import { ModelCallError } from '../../src/ports/model/model.js';
import type { ModelPort, ModelRequest } from '../../src/ports/model/model.js';

/** 空闲阈值（毫秒）：取小值让用例快速跑到中止。 */
const IDLE_MS = 60;

const request: ModelRequest = {
  messages: [{ role: 'user', content: 'ping' }],
  tools: [],
};

/**
 * 「接了 TCP 但不回包」的服务端桩：只在请求 signal 被中止时 reject。
 * 这正是守卫要收敛的病态形态——若无 signal 传下来，本 Promise 永不 settle。
 * @returns 替换 `globalThis.fetch` 的实现。
 */
function hangingFetch(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal !== undefined && signal !== null, '适配器必须把 signal 传给 fetch');
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    throw new Error('unreachable：桩永不返回响应');
  }) as typeof fetch;
}

/** 在替换过 fetch 的环境里跑一次 generate，返回耗时与错误。 */
async function captureFailure(
  model: ModelPort,
): Promise<{ readonly error: unknown; readonly elapsedMs: number }> {
  const original = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  const started = Date.now();
  try {
    await model.generate(request);
    throw new Error('前置失败：本次调用本应被空闲超时中止');
  } catch (error) {
    return { error, elapsedMs: Date.now() - started };
  } finally {
    globalThis.fetch = original;
  }
}

/** 四个适配器的构造参数（各自带上同一空闲阈值）。 */
const CASES: readonly { readonly label: string; readonly make: () => ModelPort }[] = [
  {
    label: 'OpenAiCompatibleModel',
    make: () =>
      new OpenAiCompatibleModel({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk',
        model: 'm',
        requestTimeoutMs: IDLE_MS,
      }),
  },
  {
    label: 'AnthropicModel',
    make: () =>
      new AnthropicModel({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk',
        model: 'claude-3-5-sonnet',
        requestTimeoutMs: IDLE_MS,
      }),
  },
  {
    label: 'ResponsesModel',
    make: () =>
      new ResponsesModel({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk',
        model: 'gpt-5',
        requestTimeoutMs: IDLE_MS,
      }),
  },
  {
    label: 'LlamaCppModel',
    make: () =>
      new LlamaCppModel({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3',
        requestTimeoutMs: IDLE_MS,
      }),
  },
];

for (const { label, make } of CASES) {
  test(`${label}：服务端不回包时被空闲超时有界中止，且归类为可重试错误`, async () => {
    const { error, elapsedMs } = await captureFailure(make());
    assert.ok(
      error instanceof ModelCallError,
      `${label} 应抛结构化 ModelCallError，实际：${String(error)}`,
    );
    assert.strictEqual(error.retryable, true, '空闲超时必须可重试（否则 RetryingModel 不会重试）');
    assert.match(error.message, /超时/, '消息应说明是超时');
    assert.ok(elapsedMs < IDLE_MS * 20, `${label} 中止耗时 ${String(elapsedMs)}ms，未能有界收敛`);
  });
}

test('空闲超时关闭（requestTimeoutMs: 0）且无调用方信号时不带 signal（零行为变更）', async () => {
  const model = new AnthropicModel({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk',
    model: 'm',
    requestTimeoutMs: 0,
  });
  let captured: RequestInit | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured = init;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    await model.generate(request);
  } finally {
    globalThis.fetch = original;
  }
  assert.strictEqual('signal' in (captured ?? {}), false, '关闭后须逐字回到改造前行为');
});
