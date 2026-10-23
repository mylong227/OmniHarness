/**
 * CIMD 解析判据：client_id 逐字匹配、redirect_uris、HTTPS 限制。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { McpCimd } from '../../src/mcp/mcpCimd.ts';

test('CIMD：解析并校验 client_id/redirect_uris', async () => {
  const clientId = 'https://client.example/meta.json';
  const metadata = await McpCimd.resolve(
    clientId,
    (async () =>
      new Response(
        JSON.stringify({
          client_id: clientId,
          redirect_uris: ['http://127.0.0.1:1/callback'],
          client_name: 'demo',
        }),
        { status: 200 },
      )) as typeof fetch,
  );
  assert.deepStrictEqual(metadata.redirectUris, ['http://127.0.0.1:1/callback']);
  assert.strictEqual(metadata.clientName, 'demo');
  assert.strictEqual(McpCimd.isCimd(clientId), true);
  assert.strictEqual(McpCimd.isCimd('static-client'), false);
});

test('CIMD：client_id 不一致 / 非 HTTPS / 缺 redirect_uris 都拒绝', async () => {
  const clientId = 'https://client.example/meta.json';
  await assert.rejects(
    () =>
      McpCimd.resolve(
        clientId,
        (async () =>
          new Response(
            JSON.stringify({
              client_id: 'https://evil.example/meta.json',
              redirect_uris: ['http://127.0.0.1:1/callback'],
            }),
            { status: 200 },
          )) as typeof fetch,
      ),
    /client_id 与 URL 不一致/u,
  );
  await assert.rejects(
    () =>
      McpCimd.resolve(
        'http://client.example/meta.json',
        (async () => new Response('{}', { status: 200 })) as typeof fetch,
      ),
    /必须是 HTTPS/u,
  );
  await assert.rejects(
    () =>
      McpCimd.resolve(
        clientId,
        (async () =>
          new Response(JSON.stringify({ client_id: clientId }), { status: 200 })) as typeof fetch,
      ),
    /redirect_uris/u,
  );
});
