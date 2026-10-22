/**
 * PKCE / 授权码换令牌判据（P0-3 第三片）：纯协议、无浏览器、无网络。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { McpOAuthPkce } from '../../src/mcp/mcpOAuthPkce.ts';
import { McpOAuthTokenClient } from '../../src/mcp/mcpOAuthTokenClient.ts';

test('PKCE：RFC 7636 附录 B 向量 + verifier 形态', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.strictEqual(
    McpOAuthPkce.challengeOf(verifier),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const pair = McpOAuthPkce.create(Buffer.alloc(32, 7));
  assert.strictEqual(pair.method, 'S256');
  assert.ok(pair.verifier.length >= 43 && pair.verifier.length <= 128);
  assert.ok(McpOAuthPkce.isVerifier(pair.verifier));
  assert.strictEqual(pair.challenge, McpOAuthPkce.challengeOf(pair.verifier));
});

test('授权 URL：response_type/code_challenge/state/scope/resource 全在', () => {
  const url = new URL(
    McpOAuthPkce.authorizationUrl({
      authorizationEndpoint: 'https://auth.example/authorize?x=1',
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:1234/callback',
      challenge: 'challenge',
      state: 'state-1',
      scopes: ['mcp.read', 'mcp.write'],
      resource: 'https://mcp.example',
    }),
  );
  assert.strictEqual(url.origin, 'https://auth.example');
  assert.strictEqual(url.searchParams.get('x'), '1');
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.strictEqual(url.searchParams.get('client_id'), 'client');
  assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1234/callback');
  assert.strictEqual(url.searchParams.get('code_challenge'), 'challenge');
  assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(url.searchParams.get('state'), 'state-1');
  assert.strictEqual(url.searchParams.get('scope'), 'mcp.read mcp.write');
  assert.strictEqual(url.searchParams.get('resource'), 'https://mcp.example');
});

test('回调解析：code/state 与 error 都保留', () => {
  assert.deepStrictEqual(McpOAuthPkce.parseCallback('http://127.0.0.1:1/cb?code=c1&state=s1'), {
    code: 'c1',
    state: 's1',
  });
  assert.deepStrictEqual(
    McpOAuthPkce.parseCallback('http://127.0.0.1:1/cb?error=access_denied&error_description=nope'),
    { error: 'access_denied', errorDescription: 'nope' },
  );
});

test('授权码换令牌：form 字段与响应解析', async () => {
  let body: URLSearchParams | undefined;
  let init: RequestInit | undefined;
  const fetchImpl = (async (_input: string | URL | Request, requestInit?: RequestInit) => {
    init = requestInit;
    body = new URLSearchParams(String(requestInit?.body));
    return new Response(
      JSON.stringify({ access_token: 'at', expires_in: 60, refresh_token: 'rt' }),
      { status: 200 },
    );
  }) as typeof fetch;
  const token = await McpOAuthTokenClient.authorizationCode(
    {
      tokenEndpoint: 'https://auth.example/token',
      clientId: 'client',
      code: 'code-1',
      redirectUri: 'http://127.0.0.1:1/cb',
      codeVerifier: 'verifier',
      resource: 'https://mcp.example',
      fetchImpl,
    },
    1_000,
  );
  assert.strictEqual(token.accessToken, 'at');
  assert.strictEqual(token.refreshToken, 'rt');
  assert.strictEqual(token.expiresAt, 61_000);
  assert.strictEqual(body?.get('grant_type'), 'authorization_code');
  assert.strictEqual(body?.get('client_id'), 'client');
  assert.strictEqual(body?.get('code'), 'code-1');
  assert.strictEqual(body?.get('code_verifier'), 'verifier');
  assert.strictEqual(body?.get('redirect_uri'), 'http://127.0.0.1:1/cb');
  assert.strictEqual(body?.get('resource'), 'https://mcp.example');
  assert.strictEqual(init?.method, 'POST');
  assert.strictEqual(init?.redirect, 'error');
  assert.strictEqual(
    (init?.headers as Record<string, string> | undefined)?.['content-type'],
    'application/x-www-form-urlencoded',
  );
});
