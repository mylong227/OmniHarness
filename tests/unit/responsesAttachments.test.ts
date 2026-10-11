/**
 * Responses 通路「附件发不出去」的显式告警判据（C2，2026-10-11）。
 *
 * ## 它拦的是什么
 *
 * `ResponsesModel.splitSystem` 把每条消息投影成 `{role, content}`，而 `ModelMessage.images`
 * / `.files` 不在投影里 ⇒ 用户在会话里贴的图会**无声消失**：模型照着纯文本作答，调用方以为图发出去了。
 * 同仓 `llamaCppModel` 至少记一条 debug，本通路连 debug 都没有（`viewImageTool` 只声明
 * openai/anthropic 支持，说明边界本来清楚，但**运行期零信号**）。
 *
 * ## 口径
 *
 * 本轮**不改协议序列化**（本仓纪律：无真实样本不推断 Responses 的多模态 wire 格式），
 * 只要求"丢了什么、该换哪条通路"被如实报出来——即这条判据钉的是**可见性**，
 * 不是"必须支持图片"。将来真支持了，判据①应改成"图片进了请求体"，而不是删掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesModel } from '../../src/adapters/model/responsesModel.js';
import type { ModelRequest } from '../../src/ports/model/model.js';

/** 最小合法请求（适配器只要求 messages/tools 存在）。 */
const REQUEST: ModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

/**
 * 用桩 `fetch` 跑一段异步断言，并采集 stderr 上的结构化日志行。
 *
 * 采集方式沿用本仓既有夹具（`cacheHitRateWatch.test.ts`）：临时接管 `process.stderr.write`。
 * @param body 端点返回的 JSON 体。
 * @param fn 断言体（收到采集到的日志行）。
 * @returns 无返回值。
 */
async function withCapturedStderr(
  body: unknown,
  fn: (lines: readonly string[]) => Promise<void>,
): Promise<void> {
  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalFetch = globalThis.fetch;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof fetch;
  try {
    await fn(lines);
  } finally {
    process.stderr.write = originalWrite;
    globalThis.fetch = originalFetch;
  }
}

/**
 * 解析采集到的 JSON 日志行（忽略非 JSON 噪声）。
 * @param lines 采集到的原始行。
 * @returns 解析后的日志条目。
 */
function parseLog(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('① 请求带图片 ⇒ 必须有一条 warn 级告警，且数量如实', async () => {
  const model = new ResponsesModel({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub' });
  const request: ModelRequest = {
    ...REQUEST,
    messages: [
      { role: 'user', content: '看这张图' },
      { role: 'user', content: '还有这张', images: [{ mediaType: 'image/png', data: 'AAA' }] },
    ],
  };
  await withCapturedStderr(
    { output: [], usage: { input_tokens: 1, output_tokens: 1 } },
    async (lines) => {
      await model.generate(request);
      const hit = parseLog(lines).find((e) => e['msg'] === 'model.responses.attachments_dropped');
      assert.ok(
        hit !== undefined,
        `必须发出 model.responses.attachments_dropped 告警，实采：${lines.join('')}`,
      );
      assert.strictEqual(hit['level'], 'warn', '被静默丢掉的能力必须以 warn 级报出（不是 debug）');
      assert.strictEqual(hit['images'], 1);
      assert.strictEqual(hit['files'], 0);
      assert.ok(
        String(hit['hint']).includes('openai'),
        `提示必须给出可执行的替代通路，实为：${String(hit['hint'])}`,
      );
    },
  );
});

test('② 反面对照：没有附件时不得发这条告警（否则告警会退化成噪声而被忽略）', async () => {
  const model = new ResponsesModel({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub' });
  await withCapturedStderr(
    { output: [], usage: { input_tokens: 1, output_tokens: 1 } },
    async (lines) => {
      await model.generate(REQUEST);
      const hit = parseLog(lines).find((e) => e['msg'] === 'model.responses.attachments_dropped');
      assert.strictEqual(hit, undefined, `无附件时不得告警，实采：${lines.join('')}`);
    },
  );
});

test('③ 不得发送空占位：请求体里不能出现 attachments/images 这类假字段', async () => {
  const model = new ResponsesModel({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub' });
  let sent = '';
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    sent = typeof init?.body === 'string' ? init.body : '';
    return Promise.resolve(
      new Response(JSON.stringify({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await model.generate({
      ...REQUEST,
      messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: 'AAA' }] }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
  }
  assert.ok(sent.length > 0, '必须真的发出请求');
  assert.ok(
    !/input_image|image_url|"attachments"/.test(sent),
    `请求体不得出现图片/附件字段（会骗模型以为收到了）：${sent}`,
  );
});
