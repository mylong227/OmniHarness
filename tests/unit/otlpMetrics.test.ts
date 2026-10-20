import { test } from 'vitest';
import assert from 'node:assert/strict';
import { OtlpMetricsExporter } from '../../src/observability/otlpMetricsExporter.ts';
import { MetricsCollectingEventPort } from '../../src/observability/metricsCollectingEventPort.ts';
import type { EventPort } from '../../src/ports/runtime/eventPort.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

const silent: EventPort = { name: 'silent', emit: () => {} };

test('OBS-01：metrics 导出累计计数并 flush 成 OTLP 负载', async () => {
  let body = '';
  const exporter = new OtlpMetricsExporter({
    endpoint: 'http://collector/v1/metrics',
    fetchImpl: async (_url, init) => {
      body = String(init?.body ?? '');
      return new Response('', { status: 200 });
    },
  });
  const port = new MetricsCollectingEventPort({ inner: silent, exporter, flushEvery: 2 });
  port.emit({ type: 'tool_call', payload: { name: 'read_file' } } as unknown as SessionEvent);
  port.emit({
    type: 'tool_result',
    payload: { callId: 'c1', ok: false },
  } as unknown as SessionEvent);
  await port.flush();
  assert.match(body, /omniharness\.tool\.calls/);
  assert.match(body, /omniharness\.tool\.errors/);
  assert.match(body, /service\.name/);
});
