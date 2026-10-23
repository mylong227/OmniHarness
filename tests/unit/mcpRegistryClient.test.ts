/**
 * MCP Registry 只读客户端判据（mock fetch；无网络）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { McpRegistryClient } from '../../src/mcp/mcpRegistryClient.ts';

test('registry 搜索：URL/limit 正确，解析 remotes 与 packages', async () => {
  let requested = '';
  const entries = await McpRegistryClient.search('github', {
    registryUrl: 'https://registry.example/',
    limit: 5,
    fetchImpl: (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(
        JSON.stringify({
          servers: [
            {
              server: {
                name: 'io.github.owner/server',
                description: 'demo',
                version: '1.2.3',
                remotes: [{ url: 'https://mcp.example/sse' }],
                packages: [{ registryType: 'npm', identifier: '@scope/pkg' }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const url = new URL(requested);
  assert.strictEqual(url.origin, 'https://registry.example');
  assert.strictEqual(url.pathname, '/v0/servers');
  assert.strictEqual(url.searchParams.get('search'), 'github');
  assert.strictEqual(url.searchParams.get('limit'), '5');
  assert.deepStrictEqual(entries, [
    {
      name: 'io.github.owner/server',
      description: 'demo',
      version: '1.2.3',
      remotes: ['https://mcp.example/sse'],
      packages: ['npm:@scope/pkg'],
    },
  ]);
});

test('registry 非 2xx fail-closed', async () => {
  await assert.rejects(
    () =>
      McpRegistryClient.search('x', {
        fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch,
      }),
    /HTTP 503/u,
  );
});
