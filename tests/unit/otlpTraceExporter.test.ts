import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OtlpTraceExporter,
  NoopTraceExporter,
  type Span,
} from '../../src/observability/otlpTraceExporter.js';

const span: Span = {
  traceId: 't1',
  spanId: 's1',
  name: 'tool.call',
  startTimeUnixNano: '1',
  endTimeUnixNano: '2',
  attributes: [{ key: 'tool', value: { stringValue: 'shell' } }],
};

test('OtlpTraceExporter：缓冲并在 flush 时 POST OTLP/JSON 到端点', async () => {
  const posted: { url: string; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init?: { body?: string }) => {
    posted.push({ url, body: init?.body !== undefined ? JSON.parse(init.body) : undefined });
    return new Response('ok');
  }) as unknown as typeof fetch;

  const exporter = new OtlpTraceExporter({
    endpoint: 'http://collector:4318/v1/traces',
    serviceName: 'omni-test',
    fetchImpl: fakeFetch,
    maxBatch: 2,
  });
  await exporter.export([span]);
  // 未达批量阈值，不应立即发送。
  assert.strictEqual(posted.length, 0);
  await exporter.export([span]);
  await exporter.flush();
  assert.strictEqual(posted.length, 1);
  const payload = posted[0]?.body as { resourceSpans: unknown[] };
  assert.ok(Array.isArray(payload.resourceSpans));
  assert.strictEqual(posted[0]?.url, 'http://collector:4318/v1/traces');
});

test('OtlpTraceExporter：POST 失败静默丢弃（不反噬业务）', async () => {
  const failingFetch = (async () => {
    throw new Error('collector down');
  }) as unknown as typeof fetch;
  const exporter = new OtlpTraceExporter({
    endpoint: 'http://x/v1/traces',
    fetchImpl: failingFetch,
    maxBatch: 1,
  });
  // 不应抛错。
  await exporter.export([span]);
  await exporter.flush();
  assert.ok(true);
});

test('NoopTraceExporter：export/flush 均无操作', async () => {
  const noop = new NoopTraceExporter();
  await noop.export([span]);
  await noop.flush();
  assert.strictEqual(noop.name, 'noop');
});
