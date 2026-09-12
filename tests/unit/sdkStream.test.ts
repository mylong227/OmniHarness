import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodeGenerator } from '../../src/schema/codeGenerator.js';
import { protocolSchema } from '../../src/schema/protocolSchema.js';
import { SdkClient } from '../../src/sdk/sdkClient.js';
import { WebSocketSdkSocket } from '../../src/sdk/webSocketSdkSocket.js';
import type { SdkSocket } from '../../src/sdk/webSocketSdkSocket.js';
import { AppServer } from '../../src/server/appServer.js';
import { HttpBridgeTransport, HttpServer } from '../../src/server/httpServer.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 双端 socket（客户端与"服务端"互联）。 */
class PairSocket implements SdkSocket {
  public readonly sent: string[] = [];
  public peer: PairSocket | undefined;
  private messageHandler: ((text: string) => void) | undefined;
  private openHandler: (() => void) | undefined;

  public send(text: string): void {
    this.sent.push(text);
    this.peer?.deliver(text);
  }

  public close(): void {
    this.peer = undefined;
  }

  public onOpen(handler: () => void): void {
    this.openHandler = handler;
    queueMicrotask(handler);
  }

  public onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  public onClose(): void {
    // 测试用：无需处理
  }

  public onError(): void {
    // 测试用：无需处理
  }

  /** 接收对端消息。 */
  public deliver(text: string): void {
    this.messageHandler?.(text);
  }
}

/** 建一对互联 socket。 */
function socketPair(): { clientSide: PairSocket; serverSide: PairSocket } {
  const clientSide = new PairSocket();
  const serverSide = new PairSocket();
  clientSide.peer = serverSide;
  serverSide.peer = clientSide;
  return { clientSide, serverSide };
}

test('生成器：TS 客户端具备订阅能力与流式方法', () => {
  const code = new CodeGenerator().generateTs(protocolSchema);
  assert.match(code, /private readonly subscribe: \(event: string/);
  assert.match(
    code,
    /on\(event: string, handler: \(params: Record<string, unknown>\) => void\): Subscription/,
  );
  assert.match(code, /threadsCreateStream\(prompt: string, onEvent/);
  assert.match(code, /turnsRunStream\(threadId: string, prompt: string, onEvent/);
  assert.match(code, /this\.subscribe\('thread\.event', onEvent\)/);
});

test('生成器：非流式方法不生成 Stream 变体', () => {
  const code = new CodeGenerator().generateTs(protocolSchema);
  assert.doesNotMatch(code, /approvalRespondStream/);
});

test('生成器：Python 客户端具备订阅能力与流式方法', () => {
  const code = new CodeGenerator().generatePython(protocolSchema);
  assert.match(code, /def __init__\(self, call, subscribe\)/);
  assert.match(code, /def on\(self, event: str, handler\)/);
  assert.match(code, /def threads_create_stream\(self, prompt: str, on_event\)/);
  assert.match(code, /self\._subscribe\('thread\.event', on_event\)/);
  assert.match(code, /finally:\s*\n\s*off\(\)/);
  assert.doesNotMatch(code, /def approval_respond_stream/);
});

test('生成器：协议文档标注流式方法与推送事件', () => {
  const docs = new CodeGenerator().generateDocs(protocolSchema);
  assert.match(docs, /\*\*流式方法\*\*：执行期间持续推送 `thread\.event`/);
  assert.match(docs, /`threadsCreateStream` \/ `threads_create_stream`/);
});

test('SDK 客户端：流式调用期间收到服务端通知', async () => {
  const { clientSide, serverSide } = socketPair();
  const client = new SdkClient({ socket: clientSide });
  serverSide.onMessage((text) => {
    const request = JSON.parse(text) as { id: number };
    serverSide.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'thread.event', params: { type: 'user' } }),
    );
    serverSide.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'thread.event', params: { type: 'assistant' } }),
    );
    serverSide.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { threadId: 't1' } }));
  });

  const events: Record<string, unknown>[] = [];
  client.on('thread.event', (params) => events.push(params));
  const result = await client.call<{ threadId: string }>('threads.create', { prompt: 'x' });

  assert.strictEqual(result.threadId, 't1');
  assert.deepStrictEqual(events, [{ type: 'user' }, { type: 'assistant' }]);
});

test('SDK 客户端：取消订阅后不再收到通知', async () => {
  const { clientSide } = socketPair();
  const client = new SdkClient({ socket: clientSide });
  const events: Record<string, unknown>[] = [];
  const off = client.on('thread.event', (params) => events.push(params));
  off();
  clientSide.deliver(
    JSON.stringify({ jsonrpc: '2.0', method: 'thread.event', params: { type: 'user' } }),
  );
  assert.strictEqual(events.length, 0);
});

test('SDK 客户端：错误响应抛错', async () => {
  const { clientSide, serverSide } = socketPair();
  const client = new SdkClient({ socket: clientSide });
  serverSide.onMessage((text) => {
    const request = JSON.parse(text) as { id: number };
    serverSide.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: '方法不存在' },
      }),
    );
  });
  await assert.rejects(() => client.call('nope', {}), /方法不存在/);
});

test('SDK 端到端：WebSocket 连真实服务并流式收到线程事件', async () => {
  const bridge = new HttpBridgeTransport();
  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const app = new AppServer({ config, transport: bridge });
  const server = new HttpServer({ app, bridge, webDir: resolve(process.cwd(), 'web') });
  const port = await server.start(0);

  const client = new SdkClient({ socket: WebSocketSdkSocket.connect(`ws://127.0.0.1:${port}/ws`) });
  try {
    await client.ready();
    const types: unknown[] = [];
    client.on('thread.event', (params) =>
      types.push((params['event'] as { type?: string } | undefined)?.type),
    );
    const result = await client.call<{ threadId: string; steps: number }>('threads.create', {
      prompt: 'SDK 流式演示',
    });

    assert.ok(result.threadId.length > 0);
    assert.ok(types.includes('user'), '应收到 user 事件');
    assert.ok(types.includes('tool_call'), '应收到 tool_call 事件');
    assert.ok(types.includes('assistant'), '应收到 assistant 事件');
  } finally {
    client.close();
    await server.close();
  }
});
