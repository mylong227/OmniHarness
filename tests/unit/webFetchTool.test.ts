/**
 * web_fetch 单测（P2-⑬，无第三方依赖：注入抓取实现，不碰真实网络）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WebFetchTool } from '../../src/adapters/tool/web/webFetchTool.ts';
import type { FetchedDocument } from '../../src/adapters/tool/web/webFetchTool.ts';
import type { ToolContext } from '../../src/ports/tool/tool.ts';

/** 工具上下文（web_fetch 不依赖工作区，取占位值）。 */
const ctx: ToolContext = { sessionId: 's1', workspaceRoot: '/repo' };

/**
 * 抓取替身：记录收到的参数并返回预设文档。
 */
class StubFetcher {
  /** 最近一次调用的参数。 */
  public last: { url: string; maxBytes: number; timeoutMs: number } | undefined;

  /**
   * @param document 返回给工具的结果。
   * @param boom 为 true 时抛出（模拟网络失败）。
   */
  public constructor(
    private readonly document: FetchedDocument,
    private readonly boom = false,
  ) {}

  /**
   * 记录参数并返回结果。
   *
   * @param url 目标地址。
   * @param maxBytes 字节上限。
   * @param timeoutMs 超时毫秒数。
   * @returns 预设文档。
   */
  public async fetch(url: string, maxBytes: number, timeoutMs: number): Promise<FetchedDocument> {
    this.last = { url, maxBytes, timeoutMs };
    if (this.boom) {
      throw new Error('ENOTFOUND');
    }
    return this.document;
  }
}

test('HTML 响应被转成纯文本并附状态头', async () => {
  const stub = new StubFetcher({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '标题\n正文内容',
    truncated: false,
  });
  const tool = new WebFetchTool({ fetchDocument: stub.fetch.bind(stub) });
  const result = await tool.handle(
    { id: 'c1', name: 'web_fetch', arguments: { url: 'https://example.com/a' } },
    ctx,
  );
  assert.strictEqual(result.ok, true);
  assert.ok(result.output?.includes('HTTP 200'));
  assert.ok(result.output?.includes('正文内容'));
});

test('非 http(s) 一律拒绝（含本地协议）', async () => {
  const tool = new WebFetchTool({
    fetchDocument: async (): Promise<FetchedDocument> => {
      throw new Error('不应被调用');
    },
  });
  for (const url of ['file:///etc/passwd', 'ftp://x/y', 'not-a-url', '']) {
    const result = await tool.handle({ id: 'c', name: 'web_fetch', arguments: { url } }, ctx);
    assert.strictEqual(result.ok, false, `${url} 应被拒绝`);
  }
});

test('max_bytes / timeout_ms 被钳制后传给实现（非法值回落默认）', async () => {
  const stub = new StubFetcher({
    status: 200,
    contentType: 'text/plain',
    body: 'x',
    truncated: false,
  });
  const tool = new WebFetchTool({ fetchDocument: stub.fetch.bind(stub) });
  await tool.handle(
    {
      id: 'c',
      name: 'web_fetch',
      arguments: { url: 'https://e.com', max_bytes: 1e12, timeout_ms: -5 },
    },
    ctx,
  );
  assert.strictEqual(stub.last?.maxBytes, 2_000_000, '超上限应钳到硬上限');
  assert.strictEqual(stub.last?.timeoutMs, 30_000, '非法值应回落默认');
});

test('被截断时在状态头标明', async () => {
  const stub = new StubFetcher({
    status: 200,
    contentType: 'text/plain',
    body: 'abc',
    truncated: true,
  });
  const tool = new WebFetchTool({ fetchDocument: stub.fetch.bind(stub) });
  const result = await tool.handle(
    { id: 'c', name: 'web_fetch', arguments: { url: 'https://e.com' } },
    ctx,
  );
  assert.ok(result.output?.includes('已按上限截断'));
});

test('空响应体给出明确说明；抓取抛错时 ok:false', async () => {
  const empty = new WebFetchTool({
    fetchDocument: async (): Promise<FetchedDocument> => ({
      status: 204,
      contentType: '',
      body: '',
      truncated: false,
    }),
  });
  const emptyResult = await empty.handle(
    { id: 'c', name: 'web_fetch', arguments: { url: 'https://e.com' } },
    ctx,
  );
  assert.ok(emptyResult.output?.includes('响应体为空'));

  const boom = new StubFetcher({ status: 0, contentType: '', body: '', truncated: false }, true);
  const failing = new WebFetchTool({ fetchDocument: boom.fetch.bind(boom) });
  const failed = await failing.handle(
    { id: 'c', name: 'web_fetch', arguments: { url: 'https://e.com' } },
    ctx,
  );
  assert.strictEqual(failed.ok, false);
  assert.ok(failed.error?.includes('抓取失败'));
});
test('缺省限额来自 defaults/limits.json（tools 段），且与迁移前逐字一致', async () => {
  const stub = new StubFetcher({
    status: 200,
    contentType: 'text/plain',
    body: 'x',
    truncated: false,
  });
  const tool = new WebFetchTool({ fetchDocument: stub.fetch.bind(stub) });
  await tool.handle({ id: 'c', name: 'web_fetch', arguments: { url: 'https://e.com' } }, ctx);
  assert.deepStrictEqual(stub.last, { url: 'https://e.com', maxBytes: 200_000, timeoutMs: 30_000 });
});

test('注入 limits 后：缺省值真的生效，参数说明也与生效值一致', async () => {
  const stub = new StubFetcher({
    status: 200,
    contentType: 'text/plain',
    body: 'x',
    truncated: false,
  });
  const tool = new WebFetchTool({
    fetchDocument: stub.fetch.bind(stub),
    limits: { webFetchMaxBytes: 5_000, webFetchTimeoutMs: 1_234 },
  });
  await tool.handle({ id: 'c', name: 'web_fetch', arguments: { url: 'https://e.com' } }, ctx);
  assert.deepStrictEqual(stub.last, { url: 'https://e.com', maxBytes: 5_000, timeoutMs: 1_234 });
  // 参数说明里的「默认」必须跟生效限额走：否则模型按旧默认传参，等于配置没生效。
  const properties = tool.definition.parameters['properties'] as Record<
    string,
    { description: string }
  >;
  assert.match(properties['max_bytes']!.description, /5000/u);
  assert.match(properties['timeout_ms']!.description, /1234/u);
});
