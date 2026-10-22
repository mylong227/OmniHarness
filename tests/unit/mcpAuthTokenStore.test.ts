/**
 * 令牌存储判据：容量淘汰不能吞掉刚写入的键；空 accessToken 必须判为损坏。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthTokenStore, type McpStoredToken } from '../../src/mcp/mcpAuthTokenStore.ts';

function token(resource: string, accessToken = 'at'): McpStoredToken {
  return {
    accessToken,
    expiresAt: Date.now() + 60_000,
    tokenEndpoint: 'https://auth.example/token',
    clientId: 'client',
    resource,
  };
}

test('容量淘汰保留刚写入的键（即使它排序在最前）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-store-'));
  try {
    const store = new McpAuthTokenStore(join(dir, 'tokens.json'));
    for (let i = 0; i < 50; i += 1) {
      store.set(token(`r${String(i).padStart(2, '0')}`));
    }
    store.set(token('a-new'));
    assert.strictEqual(store.get('a-new')?.accessToken, 'at');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空 accessToken / 非有限 expiresAt 视为损坏，不产出空 Bearer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-store-bad-'));
  try {
    const path = join(dir, 'tokens.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        tokens: {
          'https://mcp.example': {
            accessToken: '   ',
            expiresAt: Number.POSITIVE_INFINITY,
            tokenEndpoint: 'https://auth.example/token',
            clientId: 'client',
            resource: 'https://mcp.example',
          },
        },
      }),
    );
    assert.strictEqual(new McpAuthTokenStore(path).get('https://mcp.example'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
