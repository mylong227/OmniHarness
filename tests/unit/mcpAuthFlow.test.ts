/**
 * 授权码 + PKCE 回环流程判据：本地回调、state 校验、换令牌、持久化。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpAuthFlow } from '../../src/mcp/mcpAuthFlow.ts';
import { McpAuthTokenStore } from '../../src/mcp/mcpAuthTokenStore.ts';

test('回环授权：回调 code + state → 换令牌 → 写存储', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-auth-flow-'));
  const tokenServer = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      assert.strictEqual(form.get('grant_type'), 'authorization_code');
      assert.strictEqual(form.get('code'), 'code-1');
      assert.ok((form.get('code_verifier') ?? '').length >= 43);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ access_token: 'at', expires_in: 60 }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  const address = tokenServer.address();
  assert.ok(address !== null && typeof address === 'object');
  const tokenUrl = `http://127.0.0.1:${String(address.port)}/token`;
  try {
    const store = new McpAuthTokenStore(join(dir, 'tokens.json'));
    const now = Date.now();
    const stored = await McpAuthFlow.run({
      authorizeUrl: 'https://auth.example/authorize',
      tokenUrl,
      clientId: 'client',
      resource: 'https://mcp.example',
      now,
      tokenStore: store,
      onAuthorizeUrl: (url) => {
        const parsed = new URL(url);
        const redirect = parsed.searchParams.get('redirect_uri');
        const state = parsed.searchParams.get('state');
        assert.ok(redirect !== null && state !== null);
        const callback = new URL(redirect);
        callback.searchParams.set('code', 'code-1');
        callback.searchParams.set('state', state);
        void fetch(callback);
      },
    });
    assert.strictEqual(stored.accessToken, 'at');
    assert.strictEqual(stored.expiresAt, now + 60_000);
    assert.strictEqual(store.get('https://mcp.example')?.accessToken, 'at');
  } finally {
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
