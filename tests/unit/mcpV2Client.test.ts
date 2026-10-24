/**
 * MCP 2026-07-28 无状态客户端判据：每请求 `_meta`、trace 注入、MRTR 重试形状、
 * 资源归一化、subscriptions/listen ack/通知/取消。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { Transport } from '../../src/server/transport/lineTransport.ts';
import { McpStatelessClient } from '../../src/mcp/mcpStatelessClient.ts';
import { log } from '../../src/util/logger.ts';

/** 一条脚本化请求。 */
interface ScriptedRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** 可编程的假传输：send 时按 handler 回包（异步，模拟真实线缆）。 */
class ScriptedTransport implements Transport {
  /** 已发送消息。 */
  public readonly sent: RpcMessage[] = [];
  /** 请求脚本（缺省回 `{resultType:"complete"}`）。 */
  public handler: ((request: ScriptedRequest, transport: ScriptedTransport) => void) | undefined;
  /** 入站回调。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /** 发送并交给脚本。 */
  public send(message: RpcMessage): void {
    this.sent.push(message);
    const request = message as { id?: number | string; method?: string; params?: unknown };
    if (request.id === undefined || request.method === undefined) return;
    const script: ScriptedRequest = {
      id: request.id,
      method: request.method,
      params:
        typeof request.params === 'object' && request.params !== null
          ? (request.params as Record<string, unknown>)
          : {},
    };
    queueMicrotask(() => {
      if (this.handler === undefined) {
        this.reply(script.id, { resultType: 'complete' });
        return;
      }
      this.handler(script, this);
    });
  }

  /** 登记入站回调。 */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /** 投递通知。 */
  public notify(message: RpcMessage): void {
    queueMicrotask(() => this.callback?.(message));
  }

  /** 投递响应。 */
  public reply(id: number | string, result: unknown): void {
    queueMicrotask(() => this.callback?.({ jsonrpc: '2.0', id, result } as RpcMessage));
  }

  /** 投递原始消息（ack 等）。 */
  public deliver(message: RpcMessage): void {
    queueMicrotask(() => this.callback?.(message));
  }
}

/** 取第 n 条带方法的请求参数。 */
function paramsOf(
  transport: ScriptedTransport,
  method: string,
  index = 0,
): Record<string, unknown> {
  const matches = transport.sent.filter(
    (message) => (message as { method?: string }).method === method,
  );
  const target = matches[index] as { params?: Record<string, unknown> } | undefined;
  assert.ok(target, `应有第 ${String(index + 1)} 次 ${method}`);
  return target.params ?? {};
}

test('每请求 _meta：协议版本 + clientInfo + clientCapabilities + traceparent', async () => {
  const transport = new ScriptedTransport();
  transport.handler = (request, scripted) => {
    if (request.method === 'tools/list') scripted.reply(request.id, { tools: [] });
  };
  const client = new McpStatelessClient({
    transport,
    timeoutMs: 1000,
    clientName: 'unit-client',
    clientVersion: '9.9.9',
    trace: {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      tracestate: 'vendor=abc',
      baggage: 'k=v',
    },
  });
  await client.listTools();
  const meta = paramsOf(transport, 'tools/list')['_meta'] as Record<string, unknown>;
  assert.strictEqual(meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.deepStrictEqual(meta['io.modelcontextprotocol/clientInfo'], {
    name: 'unit-client',
    version: '9.9.9',
  });
  assert.deepStrictEqual(meta['io.modelcontextprotocol/clientCapabilities'], {});
  assert.strictEqual(
    meta['traceparent'],
    '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
  );
  assert.strictEqual(meta['tracestate'], 'vendor=abc');
  assert.strictEqual(meta['baggage'], 'k=v');
  client.close();
});

test('默认能力：注入 inputHandler 时声明 elicitation', async () => {
  const transport = new ScriptedTransport();
  transport.handler = (request, scripted) => {
    if (request.method === 'tools/list') scripted.reply(request.id, { tools: [] });
  };
  const client = new McpStatelessClient({
    transport,
    timeoutMs: 1000,
    inputHandler: { resolve: async () => [] },
  });
  await client.listTools();
  const meta = paramsOf(transport, 'tools/list')['_meta'] as Record<string, unknown>;
  assert.deepStrictEqual(meta['io.modelcontextprotocol/clientCapabilities'], {
    elicitation: {},
  });
  client.close();
});

test('trace：无显式 carrier 时从 Logger 当前 trace id 派生（与既有 OTel trace 关联）', async () => {
  const transport = new ScriptedTransport();
  transport.handler = (request, scripted) => {
    if (request.method === 'tools/list') scripted.reply(request.id, { tools: [] });
  };
  const client = new McpStatelessClient({ transport, timeoutMs: 1000 });
  await log.withTrace('session-trace-id', () => client.listTools());
  const meta = paramsOf(transport, 'tools/list')['_meta'] as Record<string, unknown>;
  const expected = createHash('sha256')
    .update('session-trace-id', 'utf8')
    .digest('hex')
    .slice(0, 32);
  const traceparent = String(meta['traceparent']);
  assert.strictEqual(traceparent.split('-')[1], expected);
  client.close();
});

test('MRTR 客户端：map 形状 inputResponses + 原样回传 requestState + 新请求 id', async () => {
  const transport = new ScriptedTransport();
  let calls = 0;
  transport.handler = (request, scripted) => {
    if (request.method !== 'tools/call') return;
    calls += 1;
    if (calls === 1) {
      scripted.reply(request.id, {
        resultType: 'input_required',
        inputRequests: {
          confirm: { method: 'elicitation/create', params: { message: '确认吗？' } },
        },
        requestState: 'opaque-state-1',
      });
      return;
    }
    assert.deepStrictEqual(request.params['inputResponses'], {
      confirm: { action: 'accept', content: { answer: 'yes' } },
    });
    assert.strictEqual(request.params['requestState'], 'opaque-state-1');
    scripted.reply(request.id, {
      resultType: 'complete',
      content: [{ type: 'text', text: 'ok' }],
    });
  };
  const client = new McpStatelessClient({
    transport,
    timeoutMs: 1000,
    inputHandler: {
      resolve: async (requests) => {
        assert.strictEqual(requests[0]?.id, 'confirm');
        assert.strictEqual(requests[0]?.prompt, '确认吗？');
        return [{ id: 'confirm', value: 'yes' }];
      },
    },
  });
  const result = await client.callTool('echo', { text: 'x' });
  assert.strictEqual(result.isError, false);
  const sentCalls = transport.sent.filter(
    (message) => (message as { method?: string }).method === 'tools/call',
  ) as { id: number }[];
  assert.strictEqual(sentCalls.length, 2);
  assert.notStrictEqual(sentCalls[0]?.id, sentCalls[1]?.id, '重试必须是新的 JSON-RPC id');
  client.close();
});

test('readResource：规范 contents 形状归一为单条内容', async () => {
  const transport = new ScriptedTransport();
  transport.handler = (request, scripted) => {
    if (request.method === 'resources/read') {
      scripted.reply(request.id, {
        resultType: 'complete',
        contents: [{ uri: 'mem://a', mimeType: 'text/plain', text: 'hello' }],
      });
    }
  };
  const client = new McpStatelessClient({ transport, timeoutMs: 1000 });
  const content = await client.readResource('mem://a');
  assert.deepStrictEqual(content, { uri: 'mem://a', mimeType: 'text/plain', text: 'hello' });
  client.close();
});

test('订阅客户端：ack 过滤 + subscriptionId 通知 + close 发 cancelled', async () => {
  const transport = new ScriptedTransport();
  const notes: string[] = [];
  transport.handler = (request, scripted) => {
    if (request.method !== 'subscriptions/listen') return;
    scripted.deliver({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        notifications: { toolsListChanged: true },
        _meta: { 'io.modelcontextprotocol/subscriptionId': request.id },
      },
    } as RpcMessage);
  };
  const client = new McpStatelessClient({ transport, timeoutMs: 1000 });
  const subscription = await client.listen(
    { toolsListChanged: true, promptsListChanged: true },
    { onNotification: (notification) => notes.push(notification.method) },
  );
  assert.strictEqual(subscription.acknowledged.toolsListChanged, true);
  assert.strictEqual(subscription.acknowledged.promptsListChanged, undefined, 'ack 可收窄');
  transport.notify({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
    params: { _meta: { 'io.modelcontextprotocol/subscriptionId': subscription.id } },
  } as RpcMessage);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(notes, ['notifications/tools/list_changed']);
  subscription.close();
  const cancelled = transport.sent.at(-1) as {
    method?: string;
    params?: { requestId?: unknown };
  };
  assert.strictEqual(cancelled.method, 'notifications/cancelled');
  assert.strictEqual(cancelled.params?.requestId, subscription.id);
  client.close();
});

test('订阅客户端：服务端优雅关闭响应触发 onClose', async () => {
  const transport = new ScriptedTransport();
  let closed: unknown;
  transport.handler = (request, scripted) => {
    if (request.method !== 'subscriptions/listen') return;
    scripted.deliver({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        notifications: {},
        _meta: { 'io.modelcontextprotocol/subscriptionId': request.id },
      },
    } as RpcMessage);
    scripted.reply(request.id, {
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/subscriptionId': request.id },
    });
  };
  const client = new McpStatelessClient({ transport, timeoutMs: 1000 });
  const subscription = await client.listen({}, { onClose: (value) => (closed = value) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(typeof closed === 'object' && closed !== null);
  assert.strictEqual((closed as { resultType?: string }).resultType, 'complete');
  subscription.close();
  client.close();
});
