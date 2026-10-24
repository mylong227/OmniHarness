/**
 * MRTR（MCP 2026-07-28）客户端回路判据。
 *
 * server 第一次返回 `input_required`，client 必须把 `inputRequests` 交给宿主，
 * 带 `inputResponses` 重试；没有回答器/漏答时必须 fail-closed，不能把半截结果当成功。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { Transport } from '../../src/server/transport/lineTransport.ts';
import { McpStatelessClient } from '../../src/mcp/mcpStatelessClient.ts';

/** 第一次 tools/call 返回 input_required，第二次返回成功。 */
class MrtrTransport implements Transport {
  public readonly sent: RpcMessage[] = [];
  /** tools/call 调用次数。 */
  public calls = 0;
  private callback: ((message: RpcMessage) => void) | undefined;

  public send(message: RpcMessage): void {
    this.sent.push(message);
    const request = message as { id?: number; method?: string };
    if (request.method === 'server/discover') {
      this.reply(request.id, { protocolVersion: '2026-07-28', capabilities: { tools: {} } });
      return;
    }
    if (request.method === 'tools/call') {
      this.calls += 1;
      if (this.calls === 1) {
        this.reply(request.id, {
          resultType: 'input_required',
          inputRequests: [{ id: 'q1', prompt: '确认吗？', schema: { type: 'string' } }],
        });
        return;
      }
      this.reply(request.id, { content: [{ type: 'text', text: 'done' }], isError: false });
    }
  }

  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  private reply(id: number | undefined, result: unknown): void {
    setImmediate(() => {
      this.callback?.({ jsonrpc: '2.0', id: id ?? 0, result } as RpcMessage);
    });
  }
}

test('MRTR：input_required → 宿主回答 → 带 inputResponses 重试成功', async () => {
  const transport = new MrtrTransport();
  const seen: string[] = [];
  const client = new McpStatelessClient({
    transport,
    timeoutMs: 1000,
    inputHandler: {
      resolve: async (requests) => {
        for (const request of requests) {
          seen.push(request.id);
          assert.strictEqual(request.prompt, '确认吗？');
        }
        return [{ id: 'q1', value: 'yes' }];
      },
    },
  });
  const result = await client.callTool('confirm', {});
  assert.strictEqual(result.isError, false);
  assert.strictEqual(result.content[0]?.type, 'text');
  assert.deepStrictEqual(seen, ['q1']);
  const retry = transport.sent.filter(
    (message) => (message as { method?: string }).method === 'tools/call',
  )[1] as { params?: Record<string, unknown> };
  assert.deepStrictEqual(retry.params?.['inputResponses'], {
    q1: { action: 'accept', content: { answer: 'yes' } },
  });
  client.close();
});

test('MRTR：没有 inputHandler 时 fail-closed（不猜测、不返回半截结果）', async () => {
  const client = new McpStatelessClient({ transport: new MrtrTransport(), timeoutMs: 1000 });
  await assert.rejects(
    () => client.callTool('confirm', {}),
    /MCP_INPUT_REQUIRED: server 要求补充输入/u,
  );
  client.close();
});

test('MRTR：回答漏项时 fail-closed', async () => {
  const client = new McpStatelessClient({
    transport: new MrtrTransport(),
    timeoutMs: 1000,
    inputHandler: { resolve: async () => [] },
  });
  await assert.rejects(() => client.callTool('confirm', {}), /输入回路缺少回答/u);
  client.close();
});

test('MRTR：3 轮后仍 input_required 必须失败（不无限重试）', async () => {
  const client = new McpStatelessClient({
    transport: new AlwaysInputTransport(false),
    timeoutMs: 1000,
    inputHandler: { resolve: async () => [{ id: 'q1', value: 'yes' }] },
  });
  await assert.rejects(() => client.callTool('confirm', {}), /重试 3 轮/u);
  client.close();
});

test('MRTR：input_required 但没有 inputRequests 必须失败', async () => {
  const client = new McpStatelessClient({
    transport: new AlwaysInputTransport(true),
    timeoutMs: 1000,
    inputHandler: { resolve: async () => [] },
  });
  await assert.rejects(() => client.callTool('confirm', {}), /没有 inputRequests/u);
  client.close();
});

/** 永远返回 input_required 的假服务端（可选空 inputRequests）。 */
class AlwaysInputTransport implements Transport {
  public readonly sent: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;

  public constructor(private readonly emptyRequests: boolean) {}

  public send(message: RpcMessage): void {
    this.sent.push(message);
    const request = message as { id?: number; method?: string };
    if (request.method === 'server/discover') {
      this.reply(request.id, { protocolVersion: '2026-07-28', capabilities: { tools: {} } });
      return;
    }
    if (request.method === 'tools/call') {
      this.reply(request.id, {
        resultType: 'input_required',
        inputRequests: this.emptyRequests ? [] : [{ id: 'q1', prompt: 'again' }],
      });
    }
  }

  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  private reply(id: number | undefined, result: unknown): void {
    setImmediate(() => {
      this.callback?.({ jsonrpc: '2.0', id: id ?? 0, result } as RpcMessage);
    });
  }
}
