/**
 * **MCP 适配器协议能力**的判据（G10/T3，2026-10-03 第十五轮）。
 *
 * ## 修的是什么（两处**静默丢失**）
 *
 * 1. `sdkMcpClientAdapter` 原先把**一切非文本块**（image / audio / resource_link / resource）收敛为
 *    `{type:'text', text:''}`：远端返回一张图，模型侧只看到**空白**，且无从知道那里本来有东西；
 * 2. `structuredContent`（按 `outputSchema` 返回的机器可读结果）被**整块丢弃**——只看 `content`。
 *
 * ## 判据怎么做到"不丢块"
 *
 * 用**真 SDK 适配器**（`SdkMcpClientAdapter.connect`）接**假 stdio server**（`tests/fixtures/mcpEchoServer.ts`
 * 新增 `structured` / `rich` 两个工具），断言：
 *  - 非文本块转述为**非空且可辨识**的文本（含 MIME / URI 等信息），原始块保留在 `raw`；
 *  - `structuredContent` 原样透出，并经网关渲染进工具结果文本（模型看得见结构化字段）；
 *  - `isError` 仍如实分流为 `ok:false`，且错误文本**不因新增块而丢**。
 *
 * 为什么不用桩客户端：本项修的是**适配器边界**的丢块，桩客户端会绕过 `contentOf` 的映射逻辑；
 * 走真 stdio 也顺带覆盖 SDK 升级后的传输/握手路径（T1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SdkMcpClientAdapter } from '../../src/adapters/mcp/sdkMcpClientAdapter.js';
import { McpGateway } from '../../src/mcp/mcpGateway.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import type { McpClientPort } from '../../src/ports/mcp/mcpClientPort.js';

/** 夹具脚本（编译产物）路径。 */
function fixturePath(): string {
  return fileURLToPath(new URL('../fixtures/mcpEchoServer.js', import.meta.url));
}

/**
 * 连上假 stdio server（真 SDK 传输 + 真握手）。
 * @returns 已握手的适配器（调用方负责 close）。
 */
async function connect(): Promise<SdkMcpClientAdapter> {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath()],
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  });
  return SdkMcpClientAdapter.connect(transport, {
    clientName: 'omni-test',
    clientVersion: '0.0.0',
  });
}

test('T1：SDK 升到 1.32 后，真 stdio 传输仍能完成握手与列举（协议版本断言不破）', async () => {
  const client = await connect();
  try {
    const info = await client.initialize();
    assert.ok(
      info.protocolVersion.length > 0,
      '握手必须协商出协议版本（SDK 1.32 仍是 2025-11-25）',
    );
    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ['echo', 'boom', 'structured', 'rich']) {
      assert.ok(names.includes(expected), `工具清单应含 ${expected}，实得 ${names.join(',')}`);
    }
  } finally {
    await client.close();
  }
});

test('T3：非文本块（图片 / 资源链接）**不塌成空文本**，且原始块保留', async () => {
  const client = await connect();
  try {
    const result = await client.callTool('rich', {});
    assert.strictEqual(result.isError, false);
    assert.strictEqual(
      result.content.length,
      3,
      '三个块都应保留（此前非文本块会变成空文本块，仍然"占位"）',
    );
    const image = result.content[0]!;
    assert.strictEqual(image.type, 'image');
    assert.ok(image.text.length > 0, '图片块必须给出非空转述（此前是空串 ⇒ 静默丢块）');
    assert.match(image.text, /image\/png/, '转述应含 MIME，便于人事后定位');
    assert.ok(
      'raw' in image && image.raw !== undefined,
      '原始块必须保留（能处理富内容的调用方可直接用）',
    );

    const link = result.content[1]!;
    assert.strictEqual(link.type, 'resource_link');
    assert.match(link.text, /report\.md/, '资源链接转述应含可读标识');
    assert.match(link.text, /file:\/\/\/tmp\/report\.md/, '资源链接转述应含 URI');

    const text = result.content[2]!;
    assert.strictEqual(text.type, 'text');
    assert.strictEqual(text.text, '另附一张图与一个链接', '文本块原样保留');
  } finally {
    await client.close();
  }
});

test('T3：structuredContent 原样透出，并经网关渲染进工具结果（不再整块丢弃）', async () => {
  const client = await connect();
  try {
    const result = await client.callTool('structured', {});
    assert.deepStrictEqual(
      result.structuredContent,
      { ok: true, count: 42 },
      '结构化输出必须原样透出（此前被直接丢弃）',
    );
  } finally {
    await client.close();
  }

  // 端到端（与既有 `mcp.test.ts` 同款：网关连真子进程 + 经注册表执行）：模型侧必须**看得见**结构化字段。
  const registry = new RegistryToolPort();
  const gateway = new McpGateway({
    registry,
    context: { sessionId: 'test-session', workspaceRoot: process.cwd() },
    servers: [{ name: 'test', command: process.execPath, args: [fixturePath()] }],
  });
  try {
    await gateway.connectAll();
    const structured = await registry.execute(
      { id: 'c1', name: 'test__structured', arguments: {} },
      { sessionId: 'test-session', workspaceRoot: process.cwd() },
    );
    assert.strictEqual(structured.ok, true);
    assert.match(String(structured.output), /结构化输出/, '网关必须把结构化输出渲染进结果文本');
    assert.match(String(structured.output), /"count": 42/, '渲染内容应含结构化字段');

    const rich = await registry.execute(
      { id: 'c2', name: 'test__rich', arguments: {} },
      { sessionId: 'test-session', workspaceRoot: process.cwd() },
    );
    assert.strictEqual(rich.ok, true);
    assert.match(String(rich.output), /image\/png/, '非文本块的转述必须到达模型侧（此前是空白）');
    assert.match(String(rich.output), /report\.md/, '资源链接同样必须到达模型侧');
  } finally {
    gateway.close();
  }
});

test('T3：isError 仍如实分流为 ok:false，且错误文本不丢', async () => {
  const client = await connect();
  try {
    const result = await client.callTool('boom', {});
    assert.strictEqual(result.isError, true, 'isError 必须如实透出');
    assert.match(result.content.map((c) => c.text).join('\n'), /boom 失败/, '错误文本不得丢');
  } finally {
    await client.close();
  }
});

test('T3：形状未建模的内容块也转述为 JSON 摘要（绝不返回空串）', async () => {
  // 直接喂一个"未来形状"给适配器映射：走不到真实远端也没关系——本判据只锁"绝不空串"这条不变量。
  const client = await connect();
  try {
    const mapped = (
      SdkMcpClientAdapter as unknown as {
        contentOf(entry: unknown): { type: string; text: string };
      }
    ).contentOf({ type: 'hologram', payload: { depth: 3 } });
    assert.strictEqual(mapped.type, 'unknown');
    assert.ok(mapped.text.length > 0, '未建模形状也必须给出非空摘要');
    assert.match(mapped.text, /hologram/, '摘要应含原始类型名');
    void (client as McpClientPort);
  } finally {
    await client.close();
  }
});
