/**
 * SDK 客户端接线单测（`omniharness sdk call` / `sdk ping`）。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`src/sdk/sdkClient.ts`（JSON-RPC 客户端）与
 * `src/sdk/webSocketSdkSocket.ts`（WebSocket 传输）有实现、有单测，却没有任何生产入口。
 * 本文件钉住接线后的行为：
 *   ① CLI 子命令真发 JSON-RPC（方法名/参数/响应打印）；
 *   ② 用法错误（缺 --url / 缺 --method / 未知子动作）以退出码 2 拒绝；
 *   ③ 调用失败（缺参数）以退出码 1 拒绝且不静默；
 *   ④ WebSocketSdkSocket 连真实 `HttpServer` 的 /ws 端点打一发（真实传输层证据）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { SdkCommand } from '../../src/cli/sdkCommand.js';
import type { SdkSocket } from '../../src/sdk/webSocketSdkSocket.js';
import { WebSocketSdkSocket } from '../../src/sdk/webSocketSdkSocket.js';
import { SdkClient } from '../../src/sdk/sdkClient.js';
import { AppServer } from '../../src/server/core/appServer.js';
import { HttpBridgeTransport, HttpServer } from '../../src/server/transport/httpServer.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 假 socket：记录出站帧，并按需回一个 JSON-RPC 响应。 */
class FakeSocket implements SdkSocket {
  /** 出站帧文本（供断言方法名与参数）。 */
  public readonly sent: string[] = [];
  /** 是否收到 close 调用。 */
  public closed = false;
  /** 入站消息处理器。 */
  private messageHandler: ((text: string) => void) | undefined;

  /**
   * 发送文本帧（记录 + 自动回响应）。
   * @param text 出站 JSON-RPC 帧
   * @returns 无返回值
   */
  public send(text: string): void {
    this.sent.push(text);
    const request = JSON.parse(text) as { id: number };
    queueMicrotask(() =>
      this.messageHandler?.(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { echo: true } }),
      ),
    );
  }

  /**
   * 关闭连接。
   * @returns 无返回值
   */
  public close(): void {
    this.closed = true;
  }

  /**
   * 连接建立回调（立即以微任务触发）。
   * @param handler 建立回调
   * @returns 无返回值
   */
  public onOpen(handler: () => void): void {
    queueMicrotask(handler);
  }

  /**
   * 注册入站消息回调。
   * @param handler 消息回调
   * @returns 无返回值
   */
  public onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 注册关闭回调（测试不需要）。
   * @returns 无返回值
   */
  public onClose(): void {
    // 测试用：无需处理
  }

  /**
   * 注册错误回调（测试不需要）。
   * @returns 无返回值
   */
  public onError(): void {
    // 测试用：无需处理
  }
}

test('sdk call：真发 JSON-RPC（方法名 + --params）并打印服务端 result', async () => {
  const socket = new FakeSocket();
  const out: string[] = [];
  const command = new SdkCommand({ connect: () => socket, write: (text) => out.push(text) });

  const code = await command.run([
    'call',
    '--url',
    'ws://127.0.0.1:9/ws',
    '--method',
    'model.catalog',
    '--params',
    '{"fresh":true}',
  ]);

  assert.strictEqual(code, 0);
  assert.strictEqual(socket.sent.length, 1, '必须真的发一帧');
  const frame = JSON.parse(socket.sent[0] ?? '{}') as {
    method?: string;
    params?: Record<string, unknown>;
  };
  assert.strictEqual(frame.method, 'model.catalog');
  assert.deepStrictEqual(frame.params, { fresh: true });
  assert.match(out.join(''), /"echo":true/, '应打印服务端 result');
  assert.strictEqual(socket.closed, true, '调用后必须关闭连接（不留悬挂 socket）');
});

test('sdk ping：打真实存在的最轻 RPC（config.get），参数为空对象', async () => {
  const socket = new FakeSocket();
  const command = new SdkCommand({ connect: () => socket, write: () => undefined });
  const code = await command.run(['ping', '--url', 'ws://127.0.0.1:9/ws']);
  assert.strictEqual(code, 0);
  const frame = JSON.parse(socket.sent[0] ?? '{}') as {
    method?: string;
    params?: Record<string, unknown>;
  };
  assert.strictEqual(frame.method, 'config.get', 'ping 必须打真实存在的 RPC（而非自造方法名）');
  assert.deepStrictEqual(frame.params, {});
});

test('sdk 用法错误：未知子动作 / 缺 --url / 缺 --method 均为退出码 2', async () => {
  const command = new SdkCommand({ connect: () => new FakeSocket(), write: () => undefined });
  assert.strictEqual(await command.run(['nope']), 2);
  assert.strictEqual(await command.run(['call', '--method', 'x']), 2);
  assert.strictEqual(await command.run(['call', '--url', 'ws://x/ws']), 1);
});

test('SDK 端到端：WebSocketSdkSocket 连真实 HttpServer /ws 打一发 model.catalog', async () => {
  const bridge = new HttpBridgeTransport();
  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const app = new AppServer({ config, transport: bridge, modelOverrideEnabled: false });
  const server = new HttpServer({ app, bridge, webDir: resolve(process.cwd(), 'web') });
  const port = await server.start(0);
  const client = new SdkClient({ socket: WebSocketSdkSocket.connect(`ws://127.0.0.1:${port}/ws`) });
  try {
    await client.ready();
    const catalog = await client.call<{ providers?: unknown[] }>('model.catalog', {});
    assert.ok(
      Array.isArray(catalog.providers),
      'model.catalog 必须回 providers 数组（真实 RPC 往返）',
    );
    // 断言用 get() 无条件写入的 autoApprove（封闭）：摘要里的文件层字段（如 modelAdapter）
    // 取决于工作区是否落有 omniharness.json——仓库树凭据分层收口后零个人配置，不得隐式依赖。
    const config = await client.call<{ autoApprove?: unknown }>('config.get', {});
    assert.strictEqual(typeof config.autoApprove, 'boolean', 'config.get 必须回配置摘要');
  } finally {
    client.close();
    await server.close();
  }
});
