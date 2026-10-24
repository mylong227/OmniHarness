/**
 * MCP 2026-07-28 Streamable HTTP 服务端判据。
 *
 * 全程用**真实 http server + fetch**：POST JSON-RPC（单条/批量/通知）、头一致性、
 * 415/406/413、SSE `subscriptions/listen` 的 ack/通知/完成/断开、端口 0 真实端口、close 幂等，
 * 以及 CLI 旗标认识面。不 mock node:http，也不引入任何外部依赖。
 */
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../src/ports/tool/tool.ts';
import { McpHttpServer, type McpHttpServerOptions } from '../../src/mcp/mcpHttpServer.ts';
import { McpProtocol } from '../../src/mcp/mcpProtocol.ts';
import { ArgParser } from '../../src/cli/argParser.ts';
import { CliFlagTable } from '../../src/cli/cliFlagTable.ts';
import { cliHelp } from '../../src/cli/cliHelp.ts';

/** 现代协议版本（测试固定值）。 */
const MODERN = McpProtocol.PROTOCOL_VERSION_V2;
/** 工具执行上下文。 */
const CONTEXT: ToolContext = { sessionId: 'mcp-http-test', workspaceRoot: process.cwd() };

/** 最小工具端口：暴露 alpha/echo 两个工具，执行回显。 */
class EchoTools implements ToolPort {
  /** 端口名。 */
  public readonly name = 'echo-tools';

  /**
   * 工具清单（故意乱序，用于断言服务端按名字升序返回）。
   * @returns 工具定义列表。
   */
  public list(): readonly ToolDefinition[] {
    return ['echo', 'alpha'].map((name) => ({
      name,
      description: `工具 ${name}`,
      parameters: { type: 'object', properties: {} },
    }));
  }

  /**
   * 执行工具（回显）。
   * @param call 工具调用。
   * @returns 成功结果。
   */
  public async execute(call: ToolCall): Promise<ToolResult> {
    return { callId: call.id, ok: true, output: `done:${call.name}` };
  }
}

/** 已启动的测试服务。 */
interface RunningServer {
  /** 服务实例。 */
  readonly server: McpHttpServer;
  /** MCP 端点 URL。 */
  readonly endpoint: string;
}

/** 每个用例登记的服务（afterEach 统一关闭，避免端口泄漏）。 */
const running: McpHttpServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/**
 * 起一个测试服务（始终绑定 127.0.0.1 + 端口 0）。
 * @param overrides 服务端选项覆盖（如 gate）。
 * @returns 服务与端点 URL。
 */
async function start(overrides: Partial<McpHttpServerOptions> = {}): Promise<RunningServer> {
  const server = new McpHttpServer(
    { tools: new EchoTools(), context: CONTEXT, ...overrides },
    { host: '127.0.0.1', port: 0 },
  );
  running.push(server);
  const address = await server.listen();
  return { server, endpoint: `http://127.0.0.1:${address.port}/mcp` };
}

/**
 * 现代请求 `_meta`。
 * @returns `_meta` 对象。
 */
function modernMeta(): Record<string, unknown> {
  return {
    [McpProtocol.META_PROTOCOL_VERSION]: MODERN,
    [McpProtocol.META_CLIENT_CAPABILITIES]: {},
  };
}

/**
 * 构造请求体。
 * @param method 方法名。
 * @param params 参数。
 * @param id 请求 id（缺省 1）。
 * @returns JSON 文本。
 */
function requestBody(
  method: string,
  params: Record<string, unknown>,
  id: number | string = 1,
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/**
 * 现代请求头（版本 + 方法 + 可选 Mcp-Name）。
 * @param method 方法名。
 * @param name tools/call 的工具名。
 * @returns 请求头。
 */
function headersOf(method: string, name?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'MCP-Protocol-Version': MODERN,
    'Mcp-Method': method,
    ...(name === undefined ? {} : { 'Mcp-Name': name }),
  };
}

/**
 * POST 一个 JSON-RPC 消息。
 * @param endpoint 端点 URL。
 * @param body 请求体文本。
 * @param headers 请求头。
 * @returns fetch 响应。
 */
async function post(
  endpoint: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return await fetch(endpoint, { method: 'POST', headers, body });
}

/**
 * 读取 JSON 对象响应。
 * @param response fetch 响应。
 * @returns JSON 对象。
 */
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), '响应应是对象');
  return value as Record<string, unknown>;
}

/**
 * 读取 JSON 数组响应。
 * @param response fetch 响应。
 * @returns JSON 数组。
 */
async function jsonArrayOf(response: Response): Promise<readonly Record<string, unknown>[]> {
  const value: unknown = await response.json();
  assert.ok(Array.isArray(value), '批量响应应是数组');
  return value as readonly Record<string, unknown>[];
}

/**
 * 取响应里的 error 对象。
 * @param body JSON-RPC 响应。
 * @returns error 对象。
 */
function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  const error = body['error'];
  assert.ok(
    typeof error === 'object' && error !== null,
    `应返回 JSON-RPC error：${JSON.stringify(body)}`,
  );
  return error as Record<string, unknown>;
}

/**
 * 取响应里的 result 对象。
 * @param body JSON-RPC 响应。
 * @returns result 对象。
 */
function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  const result = body['result'];
  assert.ok(typeof result === 'object' && result !== null, '应返回 result 对象');
  return result as Record<string, unknown>;
}

/**
 * 增量读取 SSE 帧（保持连接打开，逐帧返回 JSON）。
 * @param body fetch 响应体。
 * @returns `next()` 取下一帧；`close()` 断开。
 */
function sseStreamOf(body: ReadableStream<Uint8Array>): {
  readonly next: () => Promise<Record<string, unknown>>;
  readonly close: () => void;
} {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data === '') continue;
        const parsed: unknown = JSON.parse(data);
        assert.ok(
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
          'SSE data 应是 JSON 对象',
        );
        return parsed as Record<string, unknown>;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE 流在期望帧之前结束');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, close: () => void reader.cancel() };
}

/**
 * 轮询等待条件成立。
 * @param predicate 条件。
 * @param timeoutMs 超时（默认 3 s）。
 * @returns 条件成立后 resolve。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('条件未在超时内满足');
}

test('POST 单条 JSON-RPC：200 + application/json + result 装饰与工具排序', async () => {
  const { endpoint } = await start();
  const response = await post(
    endpoint,
    requestBody('tools/list', { _meta: modernMeta() }),
    headersOf('tools/list'),
  );
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/u);
  const result = resultOf(await jsonOf(response));
  assert.strictEqual(result['resultType'], 'complete');
  assert.deepStrictEqual(
    (result['tools'] as { name: string }[]).map((tool) => tool.name),
    ['alpha', 'echo'],
  );
  const meta = result['_meta'] as Record<string, unknown>;
  assert.deepStrictEqual(meta[McpProtocol.META_SERVER_INFO], {
    name: 'omniharness',
    version: '0.1.0',
  });
});

test('POST 批量：数组响应按请求顺序返回', async () => {
  const { endpoint } = await start();
  const body = JSON.stringify([
    { jsonrpc: '2.0', id: 10, method: 'tools/list', params: { _meta: modernMeta() } },
    { jsonrpc: '2.0', id: 11, method: 'server/discover', params: { _meta: modernMeta() } },
  ]);
  const response = await post(endpoint, body, {
    'content-type': 'application/json',
    accept: 'application/json',
    'MCP-Protocol-Version': MODERN,
  });
  assert.strictEqual(response.status, 200);
  const replies = await jsonArrayOf(response);
  assert.strictEqual(replies.length, 2);
  assert.strictEqual(replies[0]?.['id'], 10);
  assert.strictEqual(replies[1]?.['id'], 11);
  assert.strictEqual(resultOf(replies[0] as Record<string, unknown>)['resultType'], 'complete');
  assert.deepStrictEqual(resultOf(replies[1] as Record<string, unknown>)['supportedVersions'], [
    MODERN,
    McpProtocol.PROTOCOL_VERSION,
  ]);
});

test('_meta 版本缺失：进入服务端校验 → -32602（JSON-RPC 语义，HTTP 200）', async () => {
  const { endpoint } = await start();
  const response = await post(
    endpoint,
    requestBody('tools/list', {
      _meta: { [McpProtocol.META_CLIENT_CAPABILITIES]: {} },
    }),
    {
      'content-type': 'application/json',
      accept: 'application/json',
      'Mcp-Method': 'tools/list',
    },
  );
  assert.strictEqual(response.status, 200);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], McpProtocol.ERROR_INVALID_PARAMS);
});

test('_meta 版本不支持：-32022 + supported/requested，HTTP 400', async () => {
  const { endpoint } = await start();
  const response = await post(
    endpoint,
    requestBody('tools/list', {
      _meta: {
        [McpProtocol.META_PROTOCOL_VERSION]: '1900-01-01',
        [McpProtocol.META_CLIENT_CAPABILITIES]: {},
      },
    }),
    {
      'content-type': 'application/json',
      accept: 'application/json',
      'MCP-Protocol-Version': '1900-01-01',
      'Mcp-Method': 'tools/list',
    },
  );
  assert.strictEqual(response.status, 400);
  const error = errorOf(await jsonOf(response));
  assert.strictEqual(error['code'], McpProtocol.ERROR_UNSUPPORTED_PROTOCOL_VERSION);
  assert.deepStrictEqual(error['data'], {
    supported: [...McpProtocol.SUPPORTED_VERSIONS],
    requested: '1900-01-01',
  });
});

test('HeaderMismatch：现代请求缺 MCP-Protocol-Version 头 → 400 -32020', async () => {
  const { endpoint } = await start();
  const response = await post(endpoint, requestBody('tools/list', { _meta: modernMeta() }), {
    'content-type': 'application/json',
    accept: 'application/json',
    'Mcp-Method': 'tools/list',
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], McpProtocol.ERROR_HEADER_MISMATCH);
});

test('HeaderMismatch：版本头与 _meta 不一致 → 400 -32020', async () => {
  const { endpoint } = await start();
  const response = await post(endpoint, requestBody('tools/list', { _meta: modernMeta() }), {
    ...headersOf('tools/list'),
    'MCP-Protocol-Version': McpProtocol.PROTOCOL_VERSION,
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], McpProtocol.ERROR_HEADER_MISMATCH);
});

test('HeaderMismatch：Mcp-Method 与 body method 不一致 → 400 -32020', async () => {
  const { endpoint } = await start();
  const response = await post(endpoint, requestBody('tools/list', { _meta: modernMeta() }), {
    ...headersOf('tools/list'),
    'Mcp-Method': 'tools/call',
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], McpProtocol.ERROR_HEADER_MISMATCH);
});

test('HeaderMismatch：Mcp-Name 与 tools/call 的 name 不一致 → 400 -32020', async () => {
  const { endpoint } = await start();
  const response = await post(
    endpoint,
    requestBody('tools/call', { name: 'echo', arguments: {}, _meta: modernMeta() }),
    headersOf('tools/call', 'alpha'),
  );
  assert.strictEqual(response.status, 400);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], McpProtocol.ERROR_HEADER_MISMATCH);
});

test('HeaderMismatch：现代 tools/call 缺 Mcp-Name 头 → 400 -32020', async () => {
  const { endpoint } = await start();
  const response = await post(
    endpoint,
    requestBody('tools/call', { name: 'echo', arguments: {}, _meta: modernMeta() }),
    {
      'content-type': 'application/json',
      accept: 'application/json',
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': 'tools/call',
    },
  );
  assert.strictEqual(response.status, 400);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], McpProtocol.ERROR_HEADER_MISMATCH);
});

test('413：请求体超过 1 MiB → 413 + JSON-RPC error', async () => {
  const { endpoint } = await start();
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: modernMeta(), padding: 'x'.repeat(1024 * 1024 + 16) },
  };
  const response = await post(endpoint, JSON.stringify(payload), headersOf('tools/list'));
  assert.strictEqual(response.status, 413);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], -32600);
});

test('415：Content-Type 非 application/json → 415 + JSON-RPC error', async () => {
  const { endpoint } = await start();
  const response = await post(endpoint, '{}', {
    'content-type': 'text/plain',
    accept: 'application/json',
  });
  assert.strictEqual(response.status, 415);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], -32600);
});

test('406：Accept 不允许 JSON/SSE → 406 + JSON-RPC error', async () => {
  const { endpoint } = await start();
  const response = await post(endpoint, requestBody('tools/list', { _meta: modernMeta() }), {
    ...headersOf('tools/list'),
    accept: 'text/html',
  });
  assert.strictEqual(response.status, 406);
  assert.strictEqual(errorOf(await jsonOf(response))['code'], -32600);
});

test('SSE subscriptions/listen：ack 首帧 → 通知 → 断开后注销订阅', async () => {
  const { endpoint, server } = await start();
  const response = await post(
    endpoint,
    requestBody('subscriptions/listen', {
      notifications: { toolsListChanged: true },
      _meta: modernMeta(),
    }),
    { ...headersOf('subscriptions/listen'), accept: 'text/event-stream' },
  );
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
  assert.ok(response.body !== null, 'SSE 响应应有 body 流');
  const stream = sseStreamOf(response.body);
  const ack = await stream.next();
  assert.strictEqual(ack['method'], McpProtocol.NOTIFICATION_SUBSCRIPTIONS_ACKNOWLEDGED);
  const ackMeta = ack['params'] as { _meta?: Record<string, unknown> };
  assert.strictEqual(ackMeta._meta?.[McpProtocol.META_SUBSCRIPTION_ID], 1);
  assert.strictEqual(server.mcp.notifyToolsChanged(), 1);
  const notification = await stream.next();
  assert.strictEqual(notification['method'], McpProtocol.NOTIFICATION_TOOLS_LIST_CHANGED);
  const noteMeta = notification['params'] as { _meta?: Record<string, unknown> };
  assert.strictEqual(noteMeta._meta?.[McpProtocol.META_SUBSCRIPTION_ID], 1);
  stream.close();
  await waitFor(() => server.mcp.notifyToolsChanged() === 0);
});

test('SSE subscriptions/listen：server.close() 先写完成响应再结束流', async () => {
  const { endpoint, server } = await start();
  const response = await post(
    endpoint,
    requestBody('subscriptions/listen', {
      notifications: { toolsListChanged: true },
      _meta: modernMeta(),
    }),
    { ...headersOf('subscriptions/listen'), accept: 'text/event-stream' },
  );
  assert.ok(response.body !== null, 'SSE 响应应有 body 流');
  const stream = sseStreamOf(response.body);
  const ack = await stream.next();
  assert.strictEqual(ack['method'], McpProtocol.NOTIFICATION_SUBSCRIPTIONS_ACKNOWLEDGED);
  await server.close();
  const completion = await stream.next();
  assert.strictEqual(completion['id'], 1);
  const result = completion['result'] as Record<string, unknown>;
  assert.strictEqual(result['resultType'], 'complete');
  const meta = result['_meta'] as Record<string, unknown>;
  assert.strictEqual(meta[McpProtocol.META_SUBSCRIPTION_ID], 1);
});

test('端口 0：listen() 回报内核分配的真实端口', async () => {
  const server = new McpHttpServer(
    { tools: new EchoTools(), context: CONTEXT },
    { host: '127.0.0.1', port: 0 },
  );
  running.push(server);
  const address = await server.listen();
  assert.strictEqual(address.host, '127.0.0.1');
  assert.ok(address.port > 0, '端口 0 必须回报真实端口');
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`);
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await jsonOf(response))['status'], 'ok');
});

test('close() 幂等：重复调用返回同一 Promise 且不抛错', async () => {
  const { server } = await start();
  const first = server.close();
  const second = server.close();
  assert.strictEqual(first, second);
  await Promise.all([first, second]);
  await server.close();
});

test('GET 健康/能力 + OPTIONS CORS 预检', async () => {
  const { endpoint } = await start();
  const health = await fetch(endpoint);
  assert.strictEqual(health.status, 200);
  const body = await jsonOf(health);
  assert.strictEqual(body['transport'], 'streamable-http');
  assert.deepStrictEqual(body['protocolVersions'], [...McpProtocol.SUPPORTED_VERSIONS]);
  const preflight = await fetch(endpoint, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://example.com',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/u);
});

test('通知（无 id）：202 Accepted 且无响应体', async () => {
  const { endpoint } = await start();
  const response = await post(
    endpoint,
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 999 },
    }),
    { 'content-type': 'application/json', accept: 'application/json' },
  );
  assert.strictEqual(response.status, 202);
  assert.strictEqual(await response.text(), '');
});

test('CLI 旗标：mcp serve 接受 --mcp-http-port/host/path，且帮助已记载', async () => {
  for (const flag of ['--mcp-http-port', '--mcp-http-host', '--mcp-http-path']) {
    assert.ok(CliFlagTable.isKnownFlag(flag), `${flag} 必须进入 CLI 认识面`);
    assert.ok(cliHelp.documentedFlags().includes(flag), `${flag} 必须写进 --help`);
  }
  const args = new ArgParser().parseArgs([
    '--prompt',
    'mcp-serve',
    '--mcp-http-port',
    '0',
    '--mcp-http-host',
    '127.0.0.1',
    '--mcp-http-path',
    '/mcp',
  ]);
  assert.ok(args !== undefined, '旗标不得被未知旗标 fail-closed 打死');
  assert.strictEqual(args.prompt, 'mcp-serve');
});
