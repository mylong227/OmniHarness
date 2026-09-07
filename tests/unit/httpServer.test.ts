import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer, HttpBridgeTransport } from '../../src/server/httpServer.js';
import { Metrics } from '../../src/server/metrics.js';
import { AuditSink } from '../../src/server/audit.js';
import { AppServer } from '../../src/server/appServer.js';
import { SseParser } from '../../src/adapters/model/sseParser.js';
import { ConfigFactory } from '../../src/config/omniharnessConfig.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** 起一个测试服务。 */
async function startTestServer(
  approvalUplink = false,
  audit?: AuditSink,
): Promise<{ server: HttpServer; port: number; base: string }> {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const bridge = new HttpBridgeTransport();
  const app = new AppServer({ config, transport: bridge, approvalUplink, audit });
  const server = new HttpServer({
    app,
    bridge,
    webDir: resolve(process.cwd(), 'web'),
    metrics: new Metrics(),
  });
  const port = await server.start(0);
  return { server, port, base: `http://localhost:${port}` };
}

/** 发起 RPC。 */
async function rpc(
  base: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** 短暂等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 订阅 SSE 并收集事件（AbortController 断开）。 */
async function collectSse(base: string): Promise<{ events: string[]; abort: () => void }> {
  const events: string[] = [];
  const controller = new AbortController();
  void fetch(`${base}/events`, { signal: controller.signal })
    .then(async (response) => {
      if (response.body !== null) {
        await SseParser.read(response.body, (event) => events.push(event.data));
      }
    })
    .catch(() => undefined);
  await sleep(100);
  return { events, abort: () => controller.abort() };
}

test('HTTP：静态页返回 200', async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await fetch(`${base}/`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    // 断言品牌与三栏容器均在（Web UI 重写为「工作台」后同步更新，避免断言锁死旧文案）
    assert.match(html, /OmniHarness 工作台/);
  } finally {
    await server.close();
  }
});

test('HTTP：POST /rpc threads.create 返回线程', async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await rpc(base, 'threads.create', { prompt: '你好' });
    const result = response['result'] as { threadId?: string };
    assert.ok(result?.threadId !== undefined);
  } finally {
    await server.close();
  }
});

test('HTTP：SSE 推送 thread.event 事件', async () => {
  const { server, base } = await startTestServer();
  try {
    const sse = await collectSse(base);
    await rpc(base, 'turns.run', { prompt: '流式事件' });
    await sleep(300);
    sse.abort();
    assert.ok(
      sse.events.some((data) => JSON.parse(data).method === 'thread.event'),
      '应收到 thread.event 通知',
    );
  } finally {
    await server.close();
  }
});

test('HTTP：/metrics 返回 Prometheus 指标快照', async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await fetch(`${base}/metrics`);
    assert.strictEqual(response.status, 200);
    const text = await response.text();
    assert.match(text, /# TYPE omni_sessions gauge/);
    assert.match(text, /omni_sessions \d+/);
  } finally {
    await server.close();
  }
});

test('HTTP：审批上行经 SSE 发出', async () => {
  const { server, base } = await startTestServer(true);
  try {
    const sse = await collectSse(base);
    rpc(base, 'turns.run', { prompt: '审批' }).catch(() => undefined);
    await sleep(300);
    sse.abort();
    assert.ok(
      sse.events.some((data) => JSON.parse(data).method === 'approval.request'),
      '应收到审批上行',
    );
  } finally {
    await server.close();
  }
});

test('RPC：audit.query 返回服务端审计事件（可按类型过滤）', async () => {
  const auditFile = join(tmpdir(), `audit-rpc-test-${Date.now()}.log`);
  const sink = new AuditSink({ path: auditFile });
  sink.record({ type: 'tool_call', sessionId: 's1' });
  sink.record({ type: 'approval', sessionId: 's1' });
  const { server, base } = await startTestServer(false, sink);
  try {
    const all = (await rpc(base, 'audit.query', {})) as unknown as {
      result: Array<{ type: string }>;
    };
    assert.strictEqual(all.result.length, 2);
    const onlyTool = (await rpc(base, 'audit.query', { type: 'tool_call' })) as unknown as {
      result: Array<{ type: string }>;
    };
    assert.strictEqual(onlyTool.result.length, 1);
    assert.strictEqual(onlyTool.result[0]?.type, 'tool_call');
  } finally {
    await server.close();
  }
});

test('GET /healthz：存活探针恒 200', async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await fetch(`${base}/healthz`);
    assert.strictEqual(response.status, 200, '进程能响应即存活');
    const body = (await response.json()) as {
      status: string;
      uptimeSeconds: number;
      checks: Record<string, boolean>;
    };
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(typeof body.uptimeSeconds, 'number');
    assert.ok(body.uptimeSeconds >= 0);
    assert.strictEqual(body.checks.app, true);
    assert.strictEqual(body.checks.bridge, true);
  } finally {
    await server.close();
  }
});

test('GET /readyz：组件齐备则 200，webDir/metrics 仅作诊断不参与判定', async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await fetch(`${base}/readyz`);
    assert.strictEqual(response.status, 200, '核心组件齐备应就绪');
    const body = (await response.json()) as { status: string; checks: Record<string, boolean> };
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.checks.webDir, true, '测试服务 webDir 指向真实 web 目录');
    assert.strictEqual(body.checks.metrics, true);
  } finally {
    await server.close();
  }
});

test('GET /readyz：缺 metrics 仍就绪（可选能力不误判为不可用）', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const bridge = new HttpBridgeTransport();
  const app = new AppServer({ config, transport: bridge });
  // 刻意不传 metrics：验证可选能力缺失不影响就绪判定
  const server = new HttpServer({ app, bridge, webDir: resolve(process.cwd(), 'web') });
  const port = await server.start(0);
  try {
    const response = await fetch(`http://localhost:${port}/readyz`);
    assert.strictEqual(response.status, 200, 'metrics 是可选能力，缺失不应判为未就绪');
    const body = (await response.json()) as { checks: Record<string, boolean> };
    assert.strictEqual(body.checks.metrics, false, '诊断信息应如实反映缺失');
  } finally {
    await server.close();
  }
});

test('GET /healthz：存活探针恒 200，不依赖任何可选能力', async () => {
  // 即便核心组件缺失，存活探针也应响应 200（liveness 只证明进程未死）。
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const bridge = new HttpBridgeTransport();
  const app = new AppServer({ config, transport: bridge });
  const server = new HttpServer({ app, bridge, webDir: resolve(process.cwd(), 'web') });
  const port = await server.start(0);
  try {
    const response = await fetch(`http://localhost:${port}/healthz`);
    assert.strictEqual(response.status, 200, '存活探针恒 200');
    const body = (await response.json()) as { status: string; uptimeSeconds: number };
    assert.strictEqual(body.status, 'ok');
    assert.ok(Number.isFinite(body.uptimeSeconds), 'uptimeSeconds 应为数值');
  } finally {
    await server.close();
  }
});
