import { test } from 'vitest';
import assert from 'node:assert/strict';

import { McpGateway } from '../../src/mcp/mcpGateway.ts';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.ts';
import type { ToolContext } from '../../src/ports/tool/tool.ts';
import type { McpClientPort } from '../../src/ports/mcp/mcpClientPort.ts';
import type { McpConnectorPort } from '../../src/ports/mcp/mcpConnectorPort.ts';
import type { McpToolDescriptor } from '../../src/ports/mcp/mcpProtocolTypes.ts';

const context: ToolContext = { sessionId: 'mcp-life', workspaceRoot: process.cwd() };

/** 只实现网关会用到的方法面（其余用 never 断言兜住）。 */
interface FakeClientShape {
  tools: McpToolDescriptor[];
  changes: (() => void) | undefined;
  calls: string[];
}

function makeClient(): McpClientPort & FakeClientShape {
  const shape: FakeClientShape = { tools: [], changes: undefined, calls: [] };
  const client = {
    get tools(): McpToolDescriptor[] {
      return shape.tools;
    },
    set tools(value: McpToolDescriptor[]) {
      shape.tools = value;
    },
    get changes(): (() => void) | undefined {
      return shape.changes;
    },
    set changes(value: (() => void) | undefined) {
      shape.changes = value;
    },
    get calls(): string[] {
      return shape.calls;
    },
    initialize: async () => ({
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: { name: 'fake', version: '1' },
    }),
    listTools: async () => shape.tools,
    callTool: async (name: string) => {
      shape.calls.push(name);
      return { content: [{ type: 'text' as const, text: `ok:${name}` }], isError: false };
    },
    listResources: async () => [],
    readResource: async (uri: string) => ({ uri, text: '' }),
    listPrompts: async () => [],
    getPrompt: async () => '',
    ping: async () => true,
    close: () => undefined,
    onToolsChanged: (listener: () => void) => {
      shape.changes = listener;
    },
  };
  return client as unknown as McpClientPort & FakeClientShape;
}

test('MCP 生命周期：tools/list_changed 重新列工具并替换注册（旧名反注册）', async () => {
  const registry = new RegistryToolPort();
  const client = makeClient();
  client.tools = [{ name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } }];
  const connector: McpConnectorPort = {
    connect: async () => ({
      client,
      info: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'fake', version: '1' },
      },
      close: () => undefined,
      onExit: () => undefined,
    }),
  };
  const gateway = new McpGateway({
    registry,
    context,
    servers: [{ name: 's', command: 'fake' }],
    connector,
  });
  try {
    await gateway.connectAll();
    assert.ok(registry.list().some((tool) => tool.name === 's__a'));

    client.tools = [
      { name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } },
      { name: 'b', description: 'b', inputSchema: { type: 'object', properties: {} } },
    ];
    client.changes?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      registry.list().some((tool) => tool.name === 's__b'),
      '新增工具必须被注册',
    );
    assert.ok(!registry.list().some((tool) => tool.name === 's__missing'));
  } finally {
    gateway.close();
  }
  assert.deepStrictEqual(
    registry.list().map((tool) => tool.name),
    [],
    'close 必须反注册全部桥接工具',
  );
});

test('MCP 生命周期：进程退出后下一次调用按需重连，且不自动重试旧调用', async () => {
  const registry = new RegistryToolPort();
  const client = makeClient();
  client.tools = [{ name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } }];
  let connects = 0;
  const exits: (() => void)[] = [];
  const connector: McpConnectorPort = {
    connect: async () => {
      connects += 1;
      return {
        client,
        info: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'fake', version: '1' },
        },
        close: () => undefined,
        onExit: (listener: () => void) => exits.push(listener),
      };
    },
  };
  const gateway = new McpGateway({
    registry,
    context,
    servers: [{ name: 's', command: 'fake' }],
    connector,
  });
  try {
    await gateway.connectAll();
    assert.strictEqual(connects, 1);

    exits[0]?.();
    assert.ok(
      registry.list().some((tool) => tool.name === 's__a'),
      '退出不反注册（等按需重连）',
    );

    const result = await registry.execute({ id: 'c1', name: 's__a', arguments: {} }, context);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(connects, 2, '失效连接在下一次调用前重连一次');
    assert.deepStrictEqual(client.calls, ['a']);
  } finally {
    gateway.close();
  }
});
