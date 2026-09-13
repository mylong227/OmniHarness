import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer, HttpBridgeTransport } from '../../src/server/transport/httpServer.js';
import { AppServer } from '../../src/server/core/appServer.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { resolve } from 'node:path';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 起测试服务。 */
async function startServer(): Promise<{ server: HttpServer; port: number }> {
  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const bridge = new HttpBridgeTransport();
  const app = new AppServer({ config, transport: bridge, modelOverrideEnabled: false });
  const server = new HttpServer({ app, bridge, webDir: resolve(process.cwd(), 'web') });
  const port = await server.start(0);
  return { server, port };
}

/** 短暂等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('WebSocket：握手成功且请求/响应/推送全通', async () => {
  const { server, port } = await startServer();
  try {
    const socket = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('握手失败'));
    });

    const responses: unknown[] = [];
    const events: string[] = [];
    socket.onmessage = (message) => {
      const data = message.data as string;
      const parsed = JSON.parse(data) as { method?: string; id?: number };
      if (parsed.method === 'thread.event') {
        events.push(parsed.method);
      } else {
        responses.push(parsed);
      }
    };

    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'threads.create',
        params: { prompt: 'ws 测试' },
      }),
    );
    // 轮询等待而非固定 sleep：首次调用含 ~1.7s 惰性初始化（与 appServer.test 同因），
    // 固定 500ms 在慢机上必 flake。
    const deadline = Date.now() + 15000;
    let response = responses.find((entry) => (entry as { id?: number }).id === 1) as
      { result?: { threadId?: string } } | undefined;
    while (Date.now() < deadline && response?.result?.threadId === undefined) {
      await sleep(25);
      response = responses.find((entry) => (entry as { id?: number }).id === 1) as
        { result?: { threadId?: string } } | undefined;
    }
    assert.ok(response?.result?.threadId !== undefined, '应收到 threads.create 响应');
    assert.ok(events.length >= 1, '应收到 thread.event 推送');

    socket.close();
  } finally {
    await server.close();
  }
});

test('WebSocket：非 /ws 路径拒绝握手', async () => {
  const { server, port } = await startServer();
  try {
    const socket = new WebSocket(`ws://localhost:${port}/other`);
    const failed = await new Promise<boolean>((resolve) => {
      socket.onerror = () => resolve(true);
      socket.onopen = () => resolve(false);
      setTimeout(() => resolve(true), 800);
    });
    assert.strictEqual(failed, true);
  } finally {
    await server.close();
  }
});
