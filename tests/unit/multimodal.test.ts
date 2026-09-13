import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import type { ModelMessage } from '../../src/ports/model/model.js';

/** 捕获下一次 fetch 的请求体，并返回最小可用响应。 */
function captureFetch(body: unknown): { captured: { url: string; init?: RequestInit } } {
  const captured: { url: string; init?: RequestInit } = { url: '' };
  const fake = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.url = String(url);
    captured.init = init;
    const res = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      json: async () => body,
    } as unknown as Response;
    return res;
  }) as typeof fetch;
  const prev = globalThis.fetch;
  globalThis.fetch = fake;
  // 测试结束后还原，避免污染其它用例。
  const restore = (): void => {
    globalThis.fetch = prev;
  };
  (globalThis as unknown as { __restoreFetch?: () => void }).__restoreFetch = restore;
  return { captured };
}

function restoreFetch(): void {
  const g = globalThis as unknown as { __restoreFetch?: () => void };
  g.__restoreFetch?.();
  delete g.__restoreFetch;
}

test('OpenAI：带 images 时 content 含 image_url', async () => {
  const { captured } = captureFetch({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  });
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'gpt',
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: '看图', images: [{ url: 'https://x/y.png' }] },
    ];
    await model.generate({ messages, tools: [] });
  } finally {
    restoreFetch();
  }
  const sent = JSON.parse(captured.init?.body as string);
  const content = sent.messages[0].content;
  assert.ok(Array.isArray(content), 'content 应为数组');
  assert.ok(
    content.some((c: { type?: string }) => c.type === 'image_url'),
    '应含 image_url 块',
  );
});

test('OpenAI：base64 图像拼成 data URI', async () => {
  const { captured } = captureFetch({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  });
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'gpt',
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: '看图', images: [{ data: 'BASE64', mediaType: 'image/png' }] },
    ];
    await model.generate({ messages, tools: [] });
  } finally {
    restoreFetch();
  }
  const sent = JSON.parse(captured.init?.body as string);
  const imgBlock = sent.messages[0].content.find((c: { type?: string }) => c.type === 'image_url');
  assert.strictEqual(imgBlock.image_url.url, 'data:image/png;base64,BASE64');
});

test('OpenAI：无 images 时退化为字符串 content（向后兼容）', async () => {
  const { captured } = captureFetch({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  });
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'gpt',
    });
    const messages: ModelMessage[] = [{ role: 'user', content: '纯文本' }];
    await model.generate({ messages, tools: [] });
  } finally {
    restoreFetch();
  }
  const sent = JSON.parse(captured.init?.body as string);
  assert.strictEqual(sent.messages[0].content, '纯文本');
  assert.ok(!Array.isArray(sent.messages[0].content));
});

test('Anthropic：带 images 时 content 含 image + source', async () => {
  const { captured } = captureFetch({ content: [{ type: 'text', text: 'ok' }] });
  try {
    const model = new AnthropicModel({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'claude',
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: '看图', images: [{ url: 'https://x/y.png' }] },
    ];
    await model.generate({ messages, tools: [] });
  } finally {
    restoreFetch();
  }
  const sent = JSON.parse(captured.init?.body as string);
  const content = sent.messages[0].content;
  assert.ok(Array.isArray(content), 'content 应为数组');
  const img = content.find((c: { type?: string }) => c.type === 'image');
  assert.ok(img !== undefined, '应含 image 块');
  assert.strictEqual(img.source.type, 'url');
  assert.strictEqual(img.source.url, 'https://x/y.png');
});

test('Anthropic：base64 图像用 media_type + data', async () => {
  const { captured } = captureFetch({ content: [{ type: 'text', text: 'ok' }] });
  try {
    const model = new AnthropicModel({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'claude',
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: '看图', images: [{ data: 'BASE64', mediaType: 'image/png' }] },
    ];
    await model.generate({ messages, tools: [] });
  } finally {
    restoreFetch();
  }
  const sent = JSON.parse(captured.init?.body as string);
  const img = sent.messages[0].content.find((c: { type?: string }) => c.type === 'image');
  assert.strictEqual(img.source.type, 'base64');
  assert.strictEqual(img.source.media_type, 'image/png');
  assert.strictEqual(img.source.data, 'BASE64');
});

test('Anthropic：无 images 时退化为字符串 content（向后兼容）', async () => {
  const { captured } = captureFetch({ content: [{ type: 'text', text: 'ok' }] });
  try {
    const model = new AnthropicModel({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'claude',
    });
    const messages: ModelMessage[] = [{ role: 'user', content: '纯文本' }];
    await model.generate({ messages, tools: [] });
  } finally {
    restoreFetch();
  }
  const sent = JSON.parse(captured.init?.body as string);
  assert.strictEqual(sent.messages[0].content, '纯文本');
  assert.ok(!Array.isArray(sent.messages[0].content));
});
