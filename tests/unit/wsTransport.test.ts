import { test } from 'vitest';
import assert from 'node:assert/strict';
import { HttpServer, HttpBridgeTransport } from '../../src/server/transport/httpServer.ts';
import { AppServer } from '../../src/server/core/appServer.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MockModel } from '../../src/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { resolve } from 'node:path';
import { tempWorkspace } from '../helpers/tempWorkspace.ts';

/** 起测试服务（可选注入鉴权令牌）。 */
async function startServer(authToken?: string): Promise<{ server: HttpServer; port: number }> {
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
  const server = new HttpServer({
    app,
    bridge,
    webDir: resolve(process.cwd(), 'web'),
    ...(authToken === undefined ? {} : { authToken }),
  });
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

test('WebSocket：带 ?token= 的升级请求可鉴权通过（查询串不得被当成路径不匹配）', async () => {
  // 旧实现用 `request.url !== '/ws'` 精确比较 ⇒ 带查询串的升级被静默 destroy，
  // 客户端只看到「WebSocket 错误」（2026-10-27 冒烟实测：serve 的 WS 检查从未真正跑通）。
  const { server, port } = await startServer('ws-secret');
  try {
    const socket = new WebSocket(`ws://localhost:${port}/ws?token=ws-secret`);
    const opened = await new Promise<boolean>((resolve) => {
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });
    assert.strictEqual(opened, true, '带正确 token 的 WS 升级应成功');
    socket.close();
  } finally {
    await server.close();
  }
});

test('WebSocket：错误 token 的升级被拒（401，不放宽鉴权）', async () => {
  const { server, port } = await startServer('ws-secret');
  try {
    const socket = new WebSocket(`ws://localhost:${port}/ws?token=wrong`);
    const failed = await new Promise<boolean>((resolve) => {
      socket.onopen = () => resolve(false);
      socket.onerror = () => resolve(true);
      setTimeout(() => resolve(true), 2000);
    });
    assert.strictEqual(failed, true);
  } finally {
    await server.close();
  }
});
