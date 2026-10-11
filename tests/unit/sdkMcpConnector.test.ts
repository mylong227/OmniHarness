/**
 * `SdkMcpConnector`（官方 SDK MCP 连接器）判据。
 *
 * ## 为什么用**注入的假传输**而不是真 stdio/真 url
 *
 * 本文件锁的是连接器自身的四条分支：形态分派、stdio 参数构造与 `command` fail-closed、
 * 远端 HTTP→SSE 回落、握手失败后的传输回收。若走真子进程/真 HTTP，判据就变成"顺手测了网络"，
 * 且失败与超时不可控——所以经 `SdkMcpConnectorDeps`（新增的可选注入缝，缺省仍用官方传输）
 * 注入**进程内假传输**：出站 JSON-RPC 由假服务端脚本应答，握手仍走**真 SDK `Client`**
 * （即 `SdkMcpClientAdapter.connect` 的真实路径没有被绕过）。
 *
 * ## 每条判据都指向一个"曾经/可能坏掉"的现场
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 客户端元数据到达握手请求（缺省 + 注入） | 上报匿名客户端，服务端无法区分调用方 |
 * | ② | stdio 参数原样转交且为**拷贝** | 调用方后续变异配置会串味到已建连接 |
 * | ③ | 缺 `command` 拒绝且**不建传输** | 静默 spawn 空命令（历史 fail-open 面） |
 * | ④ | 有 `url` 不走 stdio（分派唯一） | url 配置被当 stdio 处理，报莫名其妙的 ENOENT |
 * | ⑤ | 非 http/https 的 url 拒绝 | 把 `foo://bar` 交给 HTTP 传输，错误下沉不可读 |
 * | ⑥ | 远端 HTTP 成功则**不回落** SSE | 回落掩盖真实故障（"能连"其实是降级后的） |
 * | ⑦ | HTTP 失败回落 SSE 且**如实记录** | 静默降级：没人知道用的是 SSE |
 * | ⑧ | 握手/启动失败必须关闭底层传输（`start` 失败那条 SDK 不兜） | 泄漏半开连接/子进程 |
 * | ⑨ | `close()` 关两端且关闭后请求被拒 | 关闭是装饰品，仍在用已死连接 |
 * | ⑩ | 断线（onclose）后挂起请求有界拒绝 | 永久挂起 ⇒ 串行屏障死锁 |
 * | ⑪ | `timeoutMs` 真的注入到请求 | 超时配置是装饰品，默认 60s |
 * | ⑫ | `tools/list` 缺字段收敛（不产生 undefined 形状） | 下游拿到 undefined 崩在别处 |
 * | ⑬ | `callTool` 的 `isError`/`structuredContent`/实参归一化 | 失败被当好结果、结构化输出被丢 |
 * | ⑭ | 非文本块保真转述（G10 路径经**连接器**仍成立） | 图片/资源块塌成空文本（G10 回归） |
 * | ⑮ | 远端 JSON-RPC 错误不得被吞成空清单 | "服务器说没有工具"与"服务器报错"混为一谈 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SdkMcpConnector } from '../../src/adapters/mcp/sdkMcpConnector.js';
import type { McpConnectorPort } from '../../src/ports/mcp/mcpConnectorPort.js';

import {
  FakeTransport,
  RecordingFactory,
  ScriptedServer,
  captureStderr,
  parseLogLines,
  remoteServer,
  settle,
  stdioServer,
} from '../helpers/scriptedServer.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

test('① 客户端元数据：缺省 omniharness/0.1.0、注入则用注入值，且真的到达 initialize 请求', async () => {
  const server = new ScriptedServer();
  const factory = new RecordingFactory(() => new FakeTransport(server));
  const handle = await new SdkMcpConnector({}, { createStdioTransport: factory.create }).connect(
    stdioServer(),
  );
  try {
    assert.deepStrictEqual(
      server.initializeParams[0]?.['clientInfo'],
      { name: 'omniharness', version: '0.1.0' },
      '缺省客户端元数据必须是 omniharness/0.1.0（不是 undefined、不是空串）',
    );
    assert.strictEqual(handle.info.serverInfo.name, 'fake-mcp');
    assert.strictEqual(handle.info.protocolVersion, '2025-06-18');
  } finally {
    handle.close();
  }

  const server2 = new ScriptedServer();
  const factory2 = new RecordingFactory(() => new FakeTransport(server2));
  const handle2 = await new SdkMcpConnector(
    { clientName: 'omni-test', clientVersion: '2.3.4' },
    { createStdioTransport: factory2.create },
  ).connect(stdioServer());
  try {
    assert.deepStrictEqual(server2.initializeParams[0]?.['clientInfo'], {
      name: 'omni-test',
      version: '2.3.4',
    });
  } finally {
    handle2.close();
  }
});

test('② stdio 形态：command/args/env/cwd 原样转交，且 args/env 是拷贝（不共享调用方引用）', async () => {
  const server = new ScriptedServer();
  const factory = new RecordingFactory(() => new FakeTransport(server));
  const args = ['-y', 'pkg', '--flag'];
  const env = { TOKEN: 'x' };
  const handle = await new SdkMcpConnector({}, { createStdioTransport: factory.create }).connect({
    name: 'local',
    command: 'npx',
    args,
    env,
    cwd: '/tmp/work',
  });
  try {
    const parameters = factory.calls[0] as {
      readonly command?: unknown;
      readonly args?: readonly string[];
      readonly env?: Record<string, string>;
      readonly cwd?: unknown;
    };
    assert.strictEqual(parameters.command, 'npx');
    assert.deepStrictEqual(parameters.args, ['-y', 'pkg', '--flag']);
    assert.deepStrictEqual(parameters.env, { TOKEN: 'x' });
    assert.strictEqual(parameters.cwd, '/tmp/work');
    // 拷贝判据：共享引用时，调用方后续 push 会污染已建连接的参数。
    assert.notStrictEqual(parameters.args, args, 'args 必须是拷贝（此前直接透传引用会串味）');
    assert.notStrictEqual(parameters.env, env, 'env 必须是拷贝');
    args.push('--later');
    env.TOKEN = 'changed';
    assert.deepStrictEqual(parameters.args, ['-y', 'pkg', '--flag'], '调用方后续变异不得影响参数');
    assert.deepStrictEqual(parameters.env, { TOKEN: 'x' });
  } finally {
    handle.close();
  }
});

test('③ 缺 command 的 stdio 配置必须拒绝，且**一个传输都不许建**（绝不 spawn 空命令）', async () => {
  const server = new ScriptedServer();
  const factory = new RecordingFactory(() => new FakeTransport(server));
  const connector: McpConnectorPort = new SdkMcpConnector(
    {},
    {
      createStdioTransport: factory.create,
    },
  );
  await assert.rejects(
    async () => await connector.connect({ name: 'broken' }),
    /缺 command/,
    '必须给出可行动的显式报错',
  );
  assert.strictEqual(factory.calls.length, 0, '拒绝必须在建传输之前发生');
});

test('④ 形态分派：给 url 走远端（绝不顺带建 stdio 传输）、不给 url 走 stdio', async () => {
  const server = new ScriptedServer();
  const stdioFactory = new RecordingFactory(() => new FakeTransport(server));
  const httpFactory = new RecordingFactory(() => new FakeTransport(server));
  const handle = await new SdkMcpConnector(
    {},
    {
      createStdioTransport: stdioFactory.create,
      createStreamableHttpTransport: httpFactory.create,
    },
  ).connect(remoteServer('https://mcp.example.com/v1'));
  try {
    assert.strictEqual(stdioFactory.calls.length, 0, 'url 形态不得碰 stdio 传输');
    assert.strictEqual(httpFactory.calls.length, 1);
    assert.strictEqual(String(httpFactory.calls[0]), 'https://mcp.example.com/v1');
  } finally {
    handle.close();
  }

  const server2 = new ScriptedServer();
  const stdioFactory2 = new RecordingFactory(() => new FakeTransport(server2));
  const httpFactory2 = new RecordingFactory(() => new FakeTransport(server2));
  const handle2 = await new SdkMcpConnector(
    {},
    {
      createStdioTransport: stdioFactory2.create,
      createStreamableHttpTransport: httpFactory2.create,
    },
  ).connect(stdioServer());
  try {
    assert.strictEqual(stdioFactory2.calls.length, 1);
    assert.strictEqual(httpFactory2.calls.length, 0);
  } finally {
    handle2.close();
  }
});

test('⑤ 远端 url 非 http/https 必须拒绝：不建任何传输、不回落 SSE', async () => {
  const server = new ScriptedServer();
  const httpFactory = new RecordingFactory(() => new FakeTransport(server));
  const sseFactory = new RecordingFactory(() => new FakeTransport(server));
  const connector = new SdkMcpConnector(
    {},
    {
      createStreamableHttpTransport: httpFactory.create,
      createSseTransport: sseFactory.create,
    },
  );
  await assert.rejects(
    async () => await connector.connect(remoteServer('ws://mcp.example.com')),
    /必须是 http\/https/,
  );
  assert.strictEqual(httpFactory.calls.length, 0, '非法 url 不得建 HTTP 传输');
  assert.strictEqual(sseFactory.calls.length, 0, '非法 url 不得被 SSE 回落悄悄接住');

  // 正对照：合法的 https url 不会被这条守卫拦下（判据不是"一律拒绝远端"）。
  const ok = await connector.connect(remoteServer('https://mcp.example.com/v1'));
  ok.close();
  assert.strictEqual(httpFactory.calls.length, 1);
});

test('⑥ 远端优先 Streamable HTTP：成功时**不回落** SSE（回落不得当"成功"的下游补救）', async () => {
  const server = new ScriptedServer();
  const httpTransport = new FakeTransport(server);
  const sseFactory = new RecordingFactory(() => new FakeTransport(server));
  const handle = await new SdkMcpConnector(
    {},
    {
      createStreamableHttpTransport: () => httpTransport,
      createSseTransport: sseFactory.create,
    },
  ).connect(remoteServer());
  try {
    assert.strictEqual(httpTransport.startCount, 1, 'HTTP 传输必须真的被启动');
    assert.strictEqual(sseFactory.calls.length, 0, 'HTTP 成功时 SSE 必须零调用（否则是静默降级）');
    assert.strictEqual(handle.info.protocolVersion, '2025-06-18');
    assert.deepStrictEqual(httpTransport.negotiated, ['2025-06-18'], '协商版本必须回写传输');
  } finally {
    handle.close();
  }
});

test('⑦ 远端 HTTP 失败必须回落 SSE，并把回落原因**如实记录**（id 与 server 名不得缺）', async () => {
  // 用 `start()` 失败（而不是 initialize 回错）作 HTTP 侧故障：前者 SDK **不**兜 close，
  // 于是"失败的 HTTP 传输被回收"这条断言才真正压住连接器自己的 catch。
  const httpTransport = new FakeTransport(new ScriptedServer());
  httpTransport.failStart(new Error('HTTP 传输拒绝握手'));
  const sseServer = new ScriptedServer();
  const sseTransport = new FakeTransport(sseServer);

  let handle: Awaited<ReturnType<SdkMcpConnector['connect']>> | undefined;
  const lines = await captureStderr(async () => {
    handle = await new SdkMcpConnector(
      {},
      {
        createStreamableHttpTransport: () => httpTransport,
        createSseTransport: () => sseTransport,
      },
    ).connect(remoteServer('https://mcp.example.com/sse'));
  });
  try {
    const fallback = parseLogLines(lines).filter(
      (entry) => entry['msg'] === 'mcp.sdk.remote.fallback_sse',
    );
    assert.strictEqual(fallback.length, 1, '回落必须恰好记录一条（静默降级 = 无人知道）');
    assert.strictEqual(fallback[0]?.['server'], 'remote', '必须记录是哪台服务器');
    assert.match(
      String(fallback[0]?.['reason'] ?? ''),
      /HTTP 传输拒绝握手/,
      '必须记录 HTTP 侧失败原因（否则事后无法定位）',
    );
    assert.strictEqual(sseTransport.startCount, 1, 'SSE 必须真的接手');
    assert.strictEqual(handle?.info.serverInfo.name, 'fake-mcp');
    // 失败的那条 HTTP 传输必须就地回收：远端路径的 catch 在 `connectWith` 里，与 stdio 的 catch
    // 是**两处**——只压住 stdio 那处，等于"远端失败泄漏传输"没人管（本条断言就是为此加的）。
    assert.ok(
      httpTransport.closeCount >= 1,
      `回落后失败的 HTTP 传输必须被关闭，实际 closeCount=${String(httpTransport.closeCount)}`,
    );
  } finally {
    handle?.close();
  }
});

test('⑧ 握手失败必须关闭底层传输 + 错误原样抛出（start 失败那条**只有连接器**兜得住）', async () => {
  // (1) initialize 失败：SDK 的 `Client.connect` catch 里自己也会 `close()`（实测：把连接器 catch 里的
  //     close 删掉，本条仍为绿）。此处保留为**双保险**——SDK 将来不再兜时它就会红。
  const failing = new ScriptedServer();
  failing.methods.set('initialize', { error: { code: -32603, message: '远端拒绝握手' } });
  const transport = new FakeTransport(failing);
  const connector = new SdkMcpConnector({}, { createStdioTransport: () => transport });
  await assert.rejects(
    async () => await connector.connect(stdioServer()),
    /远端拒绝握手/,
    '错误必须原样抛出（吞掉就变成"连上了但没信息"）',
  );
  assert.ok(transport.closeCount >= 1, '握手失败必须关闭传输（否则泄漏半开连接）');

  // (2) `start()` 失败：SDK 的 `super.connect(transport)` 在它自己的 try 之外 ⇒ 它**不会**关闭传输，
  //     半开的子进程/连接只能由连接器的 catch 收掉。删掉连接器 catch 里的 close，本条立刻变红。
  const startFailed = new FakeTransport(new ScriptedServer());
  startFailed.failStart(new Error('stdio 启动失败：命令不可执行'));
  await assert.rejects(
    async () =>
      await new SdkMcpConnector({}, { createStdioTransport: () => startFailed }).connect(
        stdioServer(),
      ),
    /stdio 启动失败/,
    'start 失败的原因必须原样抛出',
  );
  assert.ok(
    startFailed.closeCount >= 1,
    `start 失败必须由连接器关闭传输（SDK 不兜这条），实际 closeCount=${String(startFailed.closeCount)}`,
  );

  // (3) 回收动作**自己失败**时不得掩盖真实原因：`close()` 抛错必须被收口，上抛的仍是 start 失败。
  //     删掉 catch 里的 `.catch(() => undefined)`，本条立刻变红（错误被换成"close 也失败"）。
  const doubleFailed = new FakeTransport(new ScriptedServer());
  doubleFailed.failStart(new Error('stdio 启动失败：命令不可执行'));
  doubleFailed.failClose(new Error('回收也失败：句柄已失效'));
  await assert.rejects(
    async () =>
      await new SdkMcpConnector({}, { createStdioTransport: () => doubleFailed }).connect(
        stdioServer(),
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /stdio 启动失败/, '必须上抛**真实原因**（start 失败）');
      assert.doesNotMatch(message, /回收也失败/, '回收失败不得顶替真实原因');
      return true;
    },
  );
  assert.ok(doubleFailed.closeCount >= 1, '回收仍必须真的被尝试过');
});

test('⑧b 远端两段（HTTP + SSE）都启动失败：两条传输都必须被回收，且上抛最后一段的真实原因', async () => {
  const httpTransport = new FakeTransport(new ScriptedServer());
  httpTransport.failStart(new Error('HTTP 传输启动失败'));
  const sseTransport = new FakeTransport(new ScriptedServer());
  sseTransport.failStart(new Error('SSE 也启动失败'));
  sseTransport.failClose(new Error('SSE 回收也失败'));

  await assert.rejects(
    async () =>
      await new SdkMcpConnector(
        {},
        {
          createStreamableHttpTransport: () => httpTransport,
          createSseTransport: () => sseTransport,
        },
      ).connect(remoteServer()),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /SSE 也启动失败/, '两段都失败时必须上抛最后一段的真实原因');
      assert.doesNotMatch(message, /SSE 回收也失败/, '回收失败不得顶替真实原因');
      return true;
    },
  );
  assert.ok(
    httpTransport.closeCount >= 1,
    `HTTP 传输必须被回收（远端路径的 catch 在 connectWith 里，与 stdio 是两处），实际 closeCount=${String(httpTransport.closeCount)}`,
  );
  assert.ok(
    sseTransport.closeCount >= 1,
    `SSE 传输必须被回收，实际 closeCount=${String(sseTransport.closeCount)}`,
  );
});

test('⑨ close()：客户端与底层传输都被关闭，且关闭后请求必须被拒绝（关闭不是装饰品）', async () => {
  const server = new ScriptedServer();
  server.methods.set('tools/list', { result: { tools: [] } });
  const transport = new FakeTransport(server);
  const handle = await new SdkMcpConnector({}, { createStdioTransport: () => transport }).connect(
    stdioServer(),
  );
  assert.deepStrictEqual(await handle.client.listTools(), [], '关闭前请求必须可用');
  handle.close();
  await settle();
  assert.ok(transport.closeCount >= 1, '底层传输必须被关闭');
  await assert.rejects(
    async () => await handle.client.listTools(),
    /已关闭/,
    '关闭后请求必须显式拒绝（此前可能继续用已死连接）',
  );
});

test('⑩ 断线：传输 onclose 后，挂起的请求必须有界拒绝（不得永久挂起串行屏障）', async () => {
  const server = new ScriptedServer();
  const transport = new FakeTransport(server);
  const handle = await new SdkMcpConnector({}, { createStdioTransport: () => transport }).connect(
    stdioServer(),
  );
  try {
    // tools/list 故意不响应 ⇒ 请求挂起；随后模拟远端断线。
    const pending = handle.client.listTools();
    pending.catch(() => undefined); // 避免未处理拒绝告警（断言在下方 await）
    await settle(1);
    transport.onclose?.();
    await assert.rejects(
      async () => await pending,
      /Connection closed/,
      '断线后挂起请求必须立刻以可读原因拒绝（否则回合永久阻塞）',
    );
  } finally {
    handle.close();
  }

  // 正对照：同样"远端不响应"，但**不**触发断线 ⇒ 同一请求以**另一个**原因失败（超时）。
  // 这说明 `/Connection closed/` 是对具体断线传播的断言，不是"任何拒绝都能过"的宽松匹配。
  const quiet = new FakeTransport(new ScriptedServer());
  const quietHandle = await new SdkMcpConnector(
    {},
    {
      createStdioTransport: () => quiet,
    },
  ).connect(stdioServer(), 200);
  try {
    await assert.rejects(
      async () => await quietHandle.client.listTools(),
      /Request timed out/,
      '未断线时不该报 "Connection closed"',
    );
  } finally {
    quietHandle.close();
  }
});

test('⑪ 超时注入：timeoutMs 真的作用到请求（未注入时 SDK 缺省 60s ⇒ 判据要求"有界且快"）', async () => {
  const server = new ScriptedServer(); // tools/list 无脚本 ⇒ 永不响应
  const transport = new FakeTransport(server);
  const handle = await new SdkMcpConnector({}, { createStdioTransport: () => transport }).connect(
    stdioServer(),
    50,
  );
  try {
    const started = Date.now();
    await assert.rejects(async () => await handle.client.listTools(), /Request timed out/);
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5_000,
      `50ms 超时必须在有界时间内生效（实际 ${String(elapsed)}ms ⇒ 超时参数没被注入）`,
    );
  } finally {
    handle.close();
  }
});

test('⑫ tools/list 解析：缺 description / 缺 properties 收敛为协议缺省（不漏 undefined 形状）', async () => {
  const server = new ScriptedServer();
  server.methods.set('tools/list', {
    result: {
      tools: [
        {
          name: 'echo',
          description: '回显',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        // SDK 侧的 ToolSchema 要求 name/inputSchema 存在，但 description、properties、required
        // 都可缺——连接器这层必须把它们收敛成本仓协议形状（而不是把 undefined 递给下游）。
        { name: 'bare', inputSchema: { type: 'object' } },
      ],
    },
  });
  const transport = new FakeTransport(server);
  const handle = await new SdkMcpConnector({}, { createStdioTransport: () => transport }).connect(
    stdioServer(),
  );
  try {
    const tools = await handle.client.listTools();
    assert.strictEqual(tools.length, 2);
    const echo = tools[0]!;
    assert.strictEqual(echo.description, '回显');
    assert.deepStrictEqual(echo.inputSchema.required, ['text'], 'required 必须原样透传');
    const bare = tools[1]!;
    assert.strictEqual(bare.name, 'bare');
    assert.strictEqual(bare.description, '', '缺失 description 必须收敛为空串而非 undefined');
    assert.deepStrictEqual(bare.inputSchema, { type: 'object', properties: {} });
    assert.notStrictEqual(bare.inputSchema.properties, undefined, 'properties 不得是 undefined');
    assert.strictEqual(
      'required' in bare.inputSchema,
      false,
      '未声明 required 时不得凭空造出空数组（缺省即"无必填"）',
    );
  } finally {
    handle.close();
  }
});

test('⑬ callTool 归一化：实参到达传输、isError 如实透出、structuredContent 原样保留', async () => {
  const server = new ScriptedServer();
  server.methods.set('tools/call', {
    result: { content: [{ type: 'text', text: 'ok' }], isError: true, structuredContent: { n: 1 } },
  });
  const transport = new FakeTransport(server);
  const handle = await new SdkMcpConnector({}, { createStdioTransport: () => transport }).connect(
    stdioServer(),
  );
  try {
    const result = await handle.client.callTool('echo', { text: '你好' });
    assert.strictEqual(result.isError, true, '远端报告失败必须如实透出（不得当好结果）');
    assert.deepStrictEqual(result.content, [{ type: 'text', text: 'ok' }]);
    assert.deepStrictEqual(result.structuredContent, { n: 1 }, '结构化输出不得被丢弃');
    const call = transport.sent.find(
      (message): message is JSONRPCMessage & { params: Record<string, unknown> } =>
        'method' in message && message.method === 'tools/call',
    );
    assert.deepStrictEqual(call?.params['arguments'], { text: '你好' }, '实参必须原样到达传输');
    assert.strictEqual(call?.params['name'], 'echo');
  } finally {
    handle.close();
  }
});

test('⑭ 非文本块保真转述：经**连接器**拿到的图片/音频/资源块不塌成空文本（G10 路径仍成立）', async () => {
  const server = new ScriptedServer();
  server.methods.set('tools/call', {
    result: {
      content: [
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'audio', mimeType: 'audio/wav', data: 'BBBB' },
        { type: 'resource_link', uri: 'file:///tmp/report.md', name: 'report.md' },
        {
          type: 'resource',
          resource: { uri: 'mem://notes', text: '内嵌', mimeType: 'text/plain' },
        },
        { type: 'text', text: '另附' },
      ],
      isError: false,
    },
  });
  const transport = new FakeTransport(server);
  const handle = await new SdkMcpConnector({}, { createStdioTransport: () => transport }).connect(
    stdioServer(),
  );
  try {
    const result = await handle.client.callTool('rich', {});
    assert.strictEqual(result.content.length, 5, '五个块都必须保留（塌掉就少块）');
    const [image, audio, link, resource, text] = result.content;
    // 显式复现 G10 修复前的错误结果：非文本块曾一律变成 {type:'text', text:''}。
    assert.notDeepStrictEqual(image, { type: 'text', text: '' }, '图片块不得塌成空文本');
    assert.strictEqual(image?.type, 'image');
    assert.match(String(image?.text), /image\/png/);
    assert.match(String(audio?.text), /audio\/wav/);
    assert.match(String(link?.text), /report\.md/);
    assert.match(String(resource?.text), /mem:\/\/notes/);
    assert.strictEqual(text?.text, '另附', '文本块原样保留');
    assert.ok('raw' in (image ?? {}), '原始块必须保留在 raw（能处理富内容的调用方直接用）');
  } finally {
    handle.close();
  }
});

test('⑮ 远端 JSON-RPC 错误不得被吞成空清单（"服务器报错"≠"服务器没有工具"）', async () => {
  const server = new ScriptedServer();
  server.methods.set('tools/list', {
    error: { code: -32601, message: 'Method not found: tools/list' },
  });
  const transport = new FakeTransport(server);
  const handle = await new SdkMcpConnector({}, { createStdioTransport: () => transport }).connect(
    stdioServer(),
  );
  try {
    await assert.rejects(async () => await handle.client.listTools(), /Method not found/);
  } finally {
    handle.close();
  }
});
