/**
 * MCP 2026-07-28 安全判据：OAuth `iss`（RFC 9207）、CIMD `application_type`、
 * issuer 维度的凭据隔离、错误信息不泄露 secret。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpAuthFlow } from '../../src/mcp/mcpAuthFlow.ts';
import { McpAuthTokenStore, type McpStoredToken } from '../../src/mcp/mcpAuthTokenStore.ts';
import { McpAuthProvider } from '../../src/mcp/mcpAuthProvider.ts';
import { McpCimd } from '../../src/mcp/mcpCimd.ts';
import { McpOAuthPkce } from '../../src/mcp/mcpOAuthPkce.ts';
import { McpSecretGuard } from '../../src/mcp/mcpSecretGuard.ts';

/** 令牌端点桩：记录兑换次数，返回固定 token。 */
interface TokenServer {
  readonly url: string;
  readonly calls: () => number;
  readonly close: () => Promise<void>;
}

/** 起一个本地令牌端点。 */
async function tokenServer(): Promise<TokenServer> {
  let calls = 0;
  const server = createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      calls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ access_token: 'at-secret-value', expires_in: 60 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${String(address.port)}/token`,
    calls: () => calls,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 跑一次授权流（回调由测试控制是否带 iss）。 */
async function runFlow(options: {
  readonly issuer?: string;
  readonly requireIssuer?: boolean;
  readonly callbackIss?: string;
  readonly tokenUrl: string;
  readonly store: McpAuthTokenStore;
}): Promise<McpStoredToken> {
  return await McpAuthFlow.run({
    authorizeUrl: 'https://auth.example/authorize',
    tokenUrl: options.tokenUrl,
    clientId: 'client',
    resource: 'https://mcp.example',
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.requireIssuer !== undefined ? { requireIssuer: options.requireIssuer } : {}),
    tokenStore: options.store,
    onAuthorizeUrl: (url) => {
      const parsed = new URL(url);
      const redirect = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      assert.ok(redirect !== null && state !== null);
      const callback = new URL(redirect);
      callback.searchParams.set('code', 'code-1');
      callback.searchParams.set('state', state);
      if (options.callbackIss !== undefined) callback.searchParams.set('iss', options.callbackIss);
      void fetch(callback);
    },
  });
}

test('OAuth iss：回调 iss 与记录 issuer 一致 → 兑换成功并持久化 issuer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-iss-ok-'));
  const server = await tokenServer();
  try {
    const store = new McpAuthTokenStore(join(dir, 'tokens.json'));
    const stored = await runFlow({
      tokenUrl: server.url,
      store,
      callbackIss: 'https://auth.example',
    });
    assert.strictEqual(stored.accessToken, 'at-secret-value');
    assert.strictEqual(stored.issuer, 'https://auth.example');
    assert.strictEqual(
      store.get('https://mcp.example', 'https://auth.example')?.accessToken,
      'at-secret-value',
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth iss：回调 iss 不匹配 → 拒绝且不兑换令牌', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-iss-bad-'));
  const server = await tokenServer();
  try {
    const store = new McpAuthTokenStore(join(dir, 'tokens.json'));
    await assert.rejects(
      () => runFlow({ tokenUrl: server.url, store, callbackIss: 'https://evil.example' }),
      /iss 与记录的 issuer 不一致/u,
    );
    assert.strictEqual(server.calls(), 0, 'iss 不匹配不得发起令牌兑换');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth iss：requireIssuer 时缺失 iss → 拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-iss-missing-'));
  const server = await tokenServer();
  try {
    const store = new McpAuthTokenStore(join(dir, 'tokens.json'));
    await assert.rejects(
      () => runFlow({ tokenUrl: server.url, store, requireIssuer: true }),
      /缺少 iss/u,
    );
    assert.strictEqual(server.calls(), 0);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth iss：显式 issuer（带路径）逐字比对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-iss-tenant-'));
  const server = await tokenServer();
  try {
    const store = new McpAuthTokenStore(join(dir, 'tokens.json'));
    const stored = await runFlow({
      tokenUrl: server.url,
      store,
      issuer: 'https://auth.example/tenant-1',
      callbackIss: 'https://auth.example/tenant-1',
    });
    assert.strictEqual(stored.issuer, 'https://auth.example/tenant-1');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth 回调解析：iss 进入 OAuthCallback', () => {
  const callback = McpOAuthPkce.parseCallback(
    'http://127.0.0.1/callback?code=c&state=s&iss=https%3A%2F%2Fauth.example',
  );
  assert.strictEqual(callback.iss, 'https://auth.example');
});

test('CIMD：application_type 解析并校验回调形态', async () => {
  const document = {
    client_id: 'https://client.example/meta.json',
    redirect_uris: ['http://127.0.0.1:33418/callback'],
    application_type: 'native',
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const metadata = await McpCimd.resolve('https://client.example/meta.json', fetchImpl);
  assert.strictEqual(metadata.applicationType, 'native');
  assert.strictEqual(McpCimd.suggestApplicationType(metadata.redirectUris), 'native');
});

test('CIMD：非法 application_type 被拒', async () => {
  const document = {
    client_id: 'https://client.example/meta.json',
    redirect_uris: ['https://client.example/callback'],
    application_type: 'desktop',
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(document), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () => McpCimd.resolve('https://client.example/meta.json', fetchImpl),
    /application_type 必须是 native 或 web/u,
  );
});

test('CIMD：application_type=web 不得使用 loopback 回调', async () => {
  const document = {
    client_id: 'https://client.example/meta.json',
    redirect_uris: ['http://127.0.0.1:33418/callback'],
    application_type: 'web',
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(document), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () => McpCimd.resolve('https://client.example/meta.json', fetchImpl),
    /不得使用 loopback/u,
  );
});

test('令牌存储：issuer 不匹配不返回凭据（跨 issuer 不复用）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-store-issuer-'));
  try {
    const store = new McpAuthTokenStore(join(dir, 'tokens.json'));
    store.set({
      accessToken: 'tok-a',
      expiresAt: Date.now() + 600_000,
      tokenEndpoint: 'https://auth-a/token',
      clientId: 'client',
      resource: 'https://mcp.example',
      issuer: 'https://auth-a',
    });
    assert.strictEqual(store.get('https://mcp.example', 'https://auth-b'), undefined);
    assert.strictEqual(store.get('https://mcp.example', 'https://auth-a')?.accessToken, 'tok-a');
    assert.strictEqual(store.get('https://mcp.example')?.accessToken, 'tok-a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('认证解析：配置的 authorizationServer 与存储 issuer 不同 → fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-auth-provider-'));
  const file = join(dir, 'tokens.json');
  const store = new McpAuthTokenStore(file);
  store.set({
    accessToken: 'tok-a',
    expiresAt: Date.now() + 600_000,
    tokenEndpoint: 'https://auth-a/token',
    clientId: 'client',
    resource: 'https://mcp.example',
    issuer: 'https://auth-a',
  });
  try {
    const server = {
      name: 'remote',
      url: 'https://mcp.example',
      auth: {
        type: 'oauth' as const,
        resource: 'https://mcp.example',
        authorizationServer: 'https://auth-b',
        tokenEndpoint: 'https://auth-b/token',
        clientId: 'client',
      },
    };
    await assert.rejects(
      () =>
        McpAuthProvider.headersOf(
          server,
          { OMNI_MCP_TOKENS_FILE: file },
          Date.now(),
          (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
        ),
      /MCP_AUTH_UNAVAILABLE/u,
    );
    const headers = await McpAuthProvider.headersOf(
      {
        ...server,
        auth: {
          ...server.auth,
          authorizationServer: 'https://auth-a',
          tokenEndpoint: 'https://auth-a/token',
        },
      },
      { OMNI_MCP_TOKENS_FILE: file },
      Date.now(),
      (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    );
    assert.strictEqual(headers['Authorization'], 'Bearer tok-a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('错误信息脱敏：Bearer / access_token / client_secret 不泄露', () => {
  const raw =
    'failed Authorization: Bearer abc.def.ghi access_token=super-secret&client_secret=top-secret ' +
    'code=one-time-code secret=known-secret';
  const redacted = McpSecretGuard.redact(raw, ['known-secret']);
  assert.doesNotMatch(redacted, /abc\.def\.ghi/u);
  assert.doesNotMatch(redacted, /super-secret|top-secret|one-time-code|known-secret/u);
  assert.match(redacted, /\[redacted\]/u);
  const error = McpSecretGuard.redactError(new Error('Bearer tok-123456'), []);
  assert.doesNotMatch(error.message, /tok-123456/u);
});
