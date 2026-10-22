/**
 * MCP 客户端认证解析判据（2026-10-22 第一片）。
 *
 * 本片只做「已有令牌 → Authorization 头」与 RFC 9728 资源元数据发现；
 * 缺令牌必须 fail-closed，绝不发匿名请求后静默失败。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthProvider } from '../../src/mcp/mcpAuthProvider.ts';
import { McpAuthTokenStore } from '../../src/mcp/mcpAuthTokenStore.ts';
import { ConfigError } from '../../src/config/configError.ts';
import { ArgParser } from '../../src/cli/argParser.ts';
import type { McpServerConfig } from '../../src/ports/mcp/mcpServerConfig.ts';

/** 最小服务器配置。 */
function server(auth: McpServerConfig['auth'], headers?: Record<string, string>): McpServerConfig {
  return {
    name: 'x',
    url: 'https://mcp.example',
    ...(auth ? { auth } : {}),
    ...(headers ? { headers } : {}),
  };
}

test('bearer：直接令牌 / 环境变量令牌都能生成 Authorization，且覆盖静态头', async () => {
  assert.deepStrictEqual(
    await McpAuthProvider.headersOf(
      server({ type: 'bearer', token: 'tok' }, { Authorization: 'old' }),
      {},
    ),
    { Authorization: 'Bearer tok' },
  );
  assert.deepStrictEqual(
    await McpAuthProvider.headersOf(
      server({ type: 'bearer', token: 'tok' }, { authorization: 'lower-old' }),
      {},
    ),
    { Authorization: 'Bearer tok' },
    '小写 authorization 也必须被认证头覆盖（HTTP 头大小写不敏感）',
  );
  assert.deepStrictEqual(
    await McpAuthProvider.headersOf(
      server({ type: 'bearer', tokenEnv: 'MCP_TOKEN' }, { 'X-Trace': '1' }),
      { MCP_TOKEN: 'env-token' },
    ),
    { 'X-Trace': '1', Authorization: 'Bearer env-token' },
  );
  await assert.rejects(
    () =>
      McpAuthProvider.headersOf(server({ type: 'bearer', token: '   ', tokenEnv: 'MCP_TOKEN' }), {
        MCP_TOKEN: 'env-token',
      }),
    /MCP_AUTH_UNAVAILABLE/u,
    '显式空白令牌 = 配错，不得静默回退到 tokenEnv',
  );
});

test('oauth：消费已有访问令牌；缺失时抛可行动错误', async () => {
  assert.deepStrictEqual(
    await McpAuthProvider.headersOf(
      server({ type: 'oauth', accessToken: 'oauth-token', resource: 'https://mcp.example' }),
      {},
    ),
    { Authorization: 'Bearer oauth-token' },
  );
  await assert.rejects(
    () => McpAuthProvider.headersOf(server({ type: 'oauth', tokenEnv: 'MISSING' }), {}),
    /MCP_AUTH_UNAVAILABLE: 服务器 "x"/u,
  );
});

test('oauth：从 mcp auth 令牌存储读取未过期令牌，不再发匿名请求', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-auth-store-'));
  try {
    const path = join(dir, 'tokens.json');
    new McpAuthTokenStore(path).set({
      accessToken: 'stored-token',
      expiresAt: Date.now() + 60_000,
      tokenEndpoint: 'https://auth.example/token',
      clientId: 'client',
      resource: 'https://mcp.example',
    });
    const headers = await McpAuthProvider.headersOf(
      server({
        type: 'oauth',
        resource: 'https://mcp.example',
        tokenEndpoint: 'https://auth.example/token',
        clientId: 'client',
      }),
      { OMNI_MCP_TOKENS_FILE: path },
    );
    assert.deepStrictEqual(headers, { Authorization: 'Bearer stored-token' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('none / 无 auth：只回静态头，不发 Authorization', async () => {
  assert.deepStrictEqual(
    await McpAuthProvider.headersOf(server({ type: 'none' }, { 'X-A': '1' }), {}),
    { 'X-A': '1' },
  );
  assert.deepStrictEqual(await McpAuthProvider.headersOf(server(undefined), {}), {});
});

test('oauth client credentials：取令牌、缓存、过期后重取', async () => {
  let calls = 0;
  let lastInit: RequestInit | undefined;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    lastInit = init;
    return new Response(
      JSON.stringify({
        access_token: `tok-${String(calls)}`,
        token_type: 'Bearer',
        expires_in: 60,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const config = server({
    type: 'oauth',
    tokenEndpoint: 'https://auth.example/token',
    clientId: 'client',
    clientSecretEnv: 'MCP_CLIENT_SECRET',
    resource: 'https://mcp.example',
    scopes: ['mcp.read'],
  });
  const first = await McpAuthProvider.headersOf(
    config,
    { MCP_CLIENT_SECRET: 'secret' },
    1_000,
    fetchImpl,
  );
  assert.deepStrictEqual(first, { Authorization: 'Bearer tok-1' });
  const body = new URLSearchParams(String(lastInit?.body));
  assert.strictEqual(body.get('grant_type'), 'client_credentials');
  assert.strictEqual(body.get('client_id'), 'client');
  assert.strictEqual(body.get('client_secret'), 'secret');
  assert.strictEqual(body.get('resource'), 'https://mcp.example');
  assert.strictEqual(body.get('scope'), 'mcp.read');
  assert.strictEqual(lastInit?.redirect, 'error');
  const cached = await McpAuthProvider.headersOf(
    config,
    { MCP_CLIENT_SECRET: 'secret' },
    2_000,
    fetchImpl,
  );
  assert.deepStrictEqual(cached, { Authorization: 'Bearer tok-1' });
  assert.strictEqual(calls, 1, '有效期内必须复用缓存');
  const refreshed = await McpAuthProvider.headersOf(
    config,
    { MCP_CLIENT_SECRET: 'secret' },
    62_000,
    fetchImpl,
  );
  assert.deepStrictEqual(refreshed, { Authorization: 'Bearer tok-2' });
  assert.strictEqual(calls, 2, '过期必须重新取令牌');
  await assert.rejects(
    () => McpAuthProvider.headersOf(config, {}, 1_000, fetchImpl),
    /MCP_AUTH_UNAVAILABLE/u,
    '缺客户端密钥时 fail-closed，不发匿名请求',
  );
});

test('oauth client credentials：非 2xx / 缺 access_token 一律 fail-closed', async () => {
  const config = server({
    type: 'oauth',
    tokenEndpoint: 'https://auth.example/token',
    clientId: 'client',
    clientSecret: 'secret',
  });
  await assert.rejects(
    () =>
      McpAuthProvider.headersOf(
        config,
        {},
        1_000,
        (async () => new Response('', { status: 500 })) as typeof fetch,
      ),
    /MCP_OAUTH_TOKEN_FAILED: token endpoint HTTP 500/u,
  );
  await assert.rejects(
    () =>
      McpAuthProvider.headersOf(
        config,
        {},
        1_000,
        (async () =>
          new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 })) as typeof fetch,
      ),
    /缺少 access_token/u,
  );
});

test('RFC 9728：path-aware 元数据 URL + resource 精确匹配；非 2xx/缺字段/不匹配都拒绝', async () => {
  const seen: string[] = [];
  const ok = await McpAuthProvider.discoverProtectedResource(
    'https://mcp.example/mcp',
    async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          resource: 'https://mcp.example/mcp',
          authorization_servers: ['https://auth.example'],
          scopes_supported: ['mcp.read'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  assert.deepStrictEqual(seen, ['https://mcp.example/.well-known/oauth-protected-resource/mcp']);
  assert.strictEqual(ok.resource, 'https://mcp.example/mcp');
  assert.deepStrictEqual(ok.authorizationServers, ['https://auth.example']);
  assert.deepStrictEqual(ok.scopesSupported, ['mcp.read']);

  await assert.rejects(
    () =>
      McpAuthProvider.discoverProtectedResource(
        'https://mcp.example/mcp',
        async () =>
          new Response(
            JSON.stringify({
              resource: 'https://mcp.example',
              authorization_servers: ['https://auth.example'],
            }),
            { status: 200 },
          ),
      ),
    /resource 不匹配/u,
  );
  for (const variant of [
    'https://MCP.EXAMPLE/mcp',
    'https://mcp.example:443/mcp',
    'https://mcp.example/./mcp',
  ]) {
    await assert.rejects(
      () =>
        McpAuthProvider.discoverProtectedResource(
          'https://mcp.example/mcp',
          async () =>
            new Response(
              JSON.stringify({
                resource: variant,
                authorization_servers: ['https://auth.example'],
              }),
              { status: 200 },
            ),
        ),
      /resource 不匹配/u,
      `规范化后相同但逐字不同的 resource 必须拒绝：${variant}`,
    );
  }
  await assert.rejects(
    () =>
      McpAuthProvider.discoverProtectedResource(
        'https://mcp.example',
        async () => new Response('', { status: 401 }),
      ),
    /HTTP 401/u,
  );
  await assert.rejects(
    () =>
      McpAuthProvider.discoverProtectedResource(
        'https://mcp.example',
        async () => new Response(JSON.stringify({ resource: 'x' }), { status: 200 }),
      ),
    /authorization_servers/u,
  );
});

test('RFC 9728：query 保留在元数据 URL，resource 仍逐字匹配', async () => {
  let seen = '';
  const ok = await McpAuthProvider.discoverProtectedResource(
    'https://mcp.example/mcp?tenant=acme',
    async (input) => {
      seen = String(input);
      return new Response(
        JSON.stringify({
          resource: 'https://mcp.example/mcp?tenant=acme',
          authorization_servers: ['https://auth.example'],
        }),
        { status: 200 },
      );
    },
  );
  assert.strictEqual(
    seen,
    'https://mcp.example/.well-known/oauth-protected-resource/mcp?tenant=acme',
  );
  assert.strictEqual(ok.resource, 'https://mcp.example/mcp?tenant=acme');
});

test('配置校验：远端 headers/auth 合法；stdio 带 auth 或未知 type 必须拒绝', () => {
  assert.doesNotThrow(() =>
    ConfigError.validateMcpServers({
      mcpServers: [
        {
          name: 'x',
          url: 'https://mcp.example',
          headers: { 'X-A': '1' },
          auth: { type: 'bearer', tokenEnv: 'MCP_TOKEN' },
        },
      ],
    }),
  );
  assert.throws(
    () =>
      ConfigError.validateMcpServers({
        mcpServers: [{ name: 'x', command: 'node', auth: { type: 'none' } }],
      }),
    /仅适用于远端/u,
  );
  assert.throws(
    () =>
      ConfigError.validateMcpServers({
        mcpServers: [{ name: 'x', url: 'https://mcp.example', auth: { type: 'magic' as never } }],
      }),
    /type 必须是/u,
  );
  assert.throws(
    () =>
      ConfigError.validateMcpServers({
        mcpServers: [
          {
            name: 'x',
            url: 'https://mcp.example',
            auth: { type: 'bearer', accessToken: 'cross-type' } as never,
          },
        ],
      }),
    /不适用于 bearer/u,
  );
});

test('配置接线：mcpServers 的 headers/auth 必须进 CLI 默认值（声明即接线）', () => {
  const defaults = ArgParser.configDefaults({
    mcpServers: [
      {
        name: 'remote',
        url: 'https://mcp.example',
        headers: { 'X-Trace': '1' },
        auth: { type: 'oauth', accessToken: 'tok', resource: 'https://mcp.example' },
      },
    ],
  });
  assert.deepStrictEqual(defaults.mcpServers, [
    {
      name: 'remote',
      url: 'https://mcp.example',
      headers: { 'X-Trace': '1' },
      auth: { type: 'oauth', accessToken: 'tok', resource: 'https://mcp.example' },
    },
  ]);
});
