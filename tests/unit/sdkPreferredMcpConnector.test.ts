/**
 * MCP 客户端方向「SDK 优先、手写回退」连接器单测（2026-10-02 第三方融合）。
 *
 * 覆盖三条路径与 spec 解析新形态：
 *  1. SDK 连接成功 ⇒ 直接用 SDK（不产生回退提示）；
 *  2. SDK 连接失败（stdio 形态）⇒ 回落手写实现，且**失败原因如实打到输出通道**（不静默）；
 *  3. SDK 连接失败（远端 url 形态）⇒ 不回落（手写实现不支持 url），原样抛出真错误；
 *  4. `NAME=URL` spec 解析为 url 形态；`NAME=CMD` 仍解析为 stdio 形态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SdkPreferredMcpConnector } from '../../src/adapters/mcp/sdkPreferredMcpConnector.js';
import { McpServerCommand } from '../../src/mcp/mcpServerCommand.js';
import type {
  McpConnectionHandle,
  McpConnectorPort,
} from '../../src/ports/mcp/mcpConnectorPort.js';
import type { McpClientPort } from '../../src/ports/mcp/mcpClientPort.js';
import type { McpInitializeResult } from '../../src/ports/mcp/mcpProtocolTypes.js';
import type { McpServerConfig } from '../../src/ports/mcp/mcpServerConfig.js';

/** 固定握手结果。 */
const handshake: McpInitializeResult = {
  protocolVersion: '2025-11-25',
  capabilities: { tools: {} },
  serverInfo: { name: 'fake-server', version: '9.9.9' },
};

/** 记录收到的连接请求（供断言哪个实现被走到）。 */
class RecordingConnector implements McpConnectorPort {
  /** 收到的 (server, timeoutMs) 序列。 */
  public readonly seen: {
    readonly server: McpServerConfig;
    readonly timeoutMs: number | undefined;
  }[] = [];

  /**
   * @param behavior 固定行为：resolve（返回假连接）或 reject。
   */
  public constructor(private readonly behavior: 'resolve' | 'reject') {}

  /**
   * 记录并按固定行为应答。
   *
   * @param server 服务器配置。
   * @param timeoutMs 请求超时。
   * @returns 假连接句柄（resolve 行为）或拒绝。
   */
  public async connect(
    server: McpServerConfig,
    timeoutMs?: number | undefined,
  ): Promise<McpConnectionHandle> {
    this.seen.push({ server, timeoutMs });
    if (this.behavior === 'reject') {
      throw new Error('连接被拒绝（测试注入）');
    }
    const client: McpClientPort = {
      initialize: async () => handshake,
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      listResources: async () => [],
      readResource: async () => ({ uri: '', text: '' }),
      listPrompts: async () => [],
      getPrompt: async () => '',
      ping: async () => true,
      close: () => undefined,
    };
    return { client, info: handshake, close: () => undefined };
  }
}

test('SDK 可用：直接走 SDK，无回退提示', async () => {
  const sdk = new RecordingConnector('resolve');
  const fallback = new RecordingConnector('resolve');
  const writes: string[] = [];
  const connector = new SdkPreferredMcpConnector({
    sdk,
    fallback,
    write: (text) => writes.push(text),
  });
  const connection = await connector.connect({ name: 'a', command: 'echo' });
  assert.strictEqual(connection.info, handshake);
  assert.strictEqual(sdk.seen.length, 1);
  assert.strictEqual(fallback.seen.length, 0);
  assert.strictEqual(writes.length, 0);
  connection.close();
});

test('SDK 失败（stdio）：回落手写并如实提示', async () => {
  const sdk = new RecordingConnector('reject');
  const fallback = new RecordingConnector('resolve');
  const writes: string[] = [];
  const connector = new SdkPreferredMcpConnector({
    sdk,
    fallback,
    write: (text) => writes.push(text),
  });
  const connection = await connector.connect({ name: 'a', command: 'echo' }, 1234);
  assert.strictEqual(fallback.seen.length, 1);
  assert.strictEqual(fallback.seen[0]?.timeoutMs, 1234, '超时必须透传给回退实现');
  assert.ok(writes.join('').includes('连接被拒绝'), '回退原因必须可见');
  assert.ok(writes.join('').includes('"a"'), '提示必须带服务器名');
  connection.close();
});

test('SDK 失败（url 形态）：不回落，原样抛出真错误', async () => {
  const sdk = new RecordingConnector('reject');
  const fallback = new RecordingConnector('resolve');
  const connector = new SdkPreferredMcpConnector({ sdk, fallback, write: () => undefined });
  await assert.rejects(
    connector.connect({ name: 'remote', url: 'https://mcp.example.com/mcp' }),
    /连接被拒绝/,
  );
  assert.strictEqual(fallback.seen.length, 0, 'url 形态绝不能回落到手写实现');
});

test('spec 解析：NAME=URL 走 url 形态，NAME=CMD 仍走 stdio 形态', () => {
  const remote = McpServerCommand.parseMcpServerSpec('docs=https://mcp.example.com/mcp');
  assert.deepStrictEqual(remote, { name: 'docs', url: 'https://mcp.example.com/mcp' });

  const local = McpServerCommand.parseMcpServerSpec('fs=npx -y @modelcontextprotocol/server-fs');
  assert.deepStrictEqual(local, {
    name: 'fs',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fs'],
  });

  assert.throws(() => McpServerCommand.parseMcpServerSpec('no-separator'), /NAME=COMMAND/);
});
