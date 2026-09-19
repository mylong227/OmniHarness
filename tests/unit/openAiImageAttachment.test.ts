/**
 * 多模态附件 HTTP 级证明（#B1/#B5）：把一张图片经 ModelMessage.files 送进
 * OpenAiCompatibleModel，断言**真实发出的 HTTP 请求体**里出现 `image_url` + base64 数据。
 *
 * 这条用例专门堵「串行化层漏接」：工具把图片写进 `ToolResult.files`，经事件 → 上下文装配器
 * 注入消息，最终必须序列化为 OpenAI 兼容的 `[text, {type:image_url, image_url:{url:"data:..."}}]`。
 * 只断言内存里的中间结构不够——HTTP 层才是 OpenAI 端点实际收到的东西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import type { ModelRequest, ModelMessage } from '../../src/ports/model/model.js';

/** 起一个本地 HTTP 端点，把收到的请求体原样回传出来（供断言），并回一个最小合法 chat 响应。 */
function startCaptureServer(): Promise<{ url: string; body: () => string; close: () => void }> {
  let captured = '';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 最小合法响应：让 parseOutput 不抛错即可。
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        body: () => captured,
        close: () => server.close(),
      });
    });
  });
}

const PNG_BYTES_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test('图片经 ModelMessage.files 注入后，HTTP 请求体含 image_url+base64', async () => {
  const server = await startCaptureServer();
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: server.url,
      apiKey: 'test-key',
      model: 'test-model',
    });

    const message: ModelMessage = {
      role: 'user',
      content: '看这张图',
      files: [{ name: 'shot.png', mediaType: 'image/png', data: PNG_BYTES_BASE64 }],
    };
    const request: ModelRequest = {
      messages: [message],
      tools: [],
    };

    const output = await model.generate(request);

    assert.strictEqual(output.text, 'ok', '应解析到响应文本');
    const body = JSON.parse(server.body());
    const wireMessage = body.messages[0];
    assert.ok(
      Array.isArray(wireMessage.content),
      '含图片时 content 应为分段数组（[text, image_url]）',
    );
    const imagePart = wireMessage.content.find((p: { type?: string }) => p.type === 'image_url');
    assert.ok(imagePart !== undefined, '请求体必须包含 image_url 段');
    assert.ok(
      imagePart.image_url.url.startsWith('data:image/png;base64,'),
      `image_url 必须是 data URI，实际: ${imagePart.image_url.url.slice(0, 40)}`,
    );
    assert.ok(
      imagePart.image_url.url.includes(PNG_BYTES_BASE64),
      'base64 数据必须原样出现在请求里',
    );
  } finally {
    server.close();
  }
});

test('非图片文件注入为文本说明（不冒充 image_url）', async () => {
  const server = await startCaptureServer();
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: server.url,
      apiKey: 'test-key',
      model: 'test-model',
    });
    const message: ModelMessage = {
      role: 'user',
      content: '读这份文档',
      files: [{ name: 'report.pdf', mediaType: 'application/pdf', data: 'JFBOR' }],
    };
    await model.generate({ messages: [message], tools: [] });

    const body = JSON.parse(server.body());
    const parts = body.messages[0].content as Array<{ type: string }>;
    assert.strictEqual(
      parts.some((p) => p.type === 'image_url'),
      false,
      '非图片不得冒充 image_url',
    );
    assert.ok(
      parts.some((p) => p.type === 'text'),
      '非图片文件应以文本说明形式注入',
    );
  } finally {
    server.close();
  }
});
