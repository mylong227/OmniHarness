/**
 * 判据：`--dump-config` 的输出必须**打码凭据**（2026-10-27 冒烟实测发现明文泄漏）。
 *
 * 旧行为：直接把 `CliArgs` 原样 `JSON.stringify` ⇒ `"apiKey": "sk-…"` 出现在 stdout。
 * 本仓对凭据的既定口径是「UI 回传一律打码、原文不回显」，CLI 这条出口曾是唯一例外。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DumpRedactor } from '../../src/cli/dumpRedactor.ts';

test('顶层 apiKey 打码，非敏感字段原样保留', () => {
  const out = DumpRedactor.redact({
    modelAdapter: 'openai',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-live-SECRET-VALUE',
    baseUrl: 'https://api.deepseek.com',
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('SECRET-VALUE'), `明文泄漏：${text}`);
  assert.match(text, /"apiKey":"<redacted>"/u);
  assert.match(text, /"model":"deepseek-v4-flash"/u);
  assert.match(text, /"baseUrl":"https:\/\/api\.deepseek\.com"/u);
});

test('mcp env/headers：名字像凭据的条目打码，PATH 保留；auth 整块遮', () => {
  const out = DumpRedactor.redact({
    mcpServers: [
      {
        name: 'demo',
        command: 'node',
        env: { PATH: '/usr/bin', DEMO_API_KEY: 'sk-env-secret', DEBUG: '1' },
        headers: { Authorization: 'Bearer header-secret', 'X-Trace': 't1' },
        auth: { type: 'oauth', clientSecret: 'oauth-secret', clientId: 'id-123' },
      },
    ],
  });
  const text = JSON.stringify(out);
  for (const secret of ['sk-env-secret', 'header-secret', 'oauth-secret']) {
    assert.ok(!text.includes(secret), `明文泄漏：${secret}`);
  }
  // 非敏感值保留：排障仍然有用（否则 dump 失去意义）。
  assert.match(text, /"PATH":"\/usr\/bin"/u);
  assert.match(text, /"DEBUG":"1"/u);
  assert.match(text, /"X-Trace":"t1"/u);
  assert.match(text, /"DEMO_API_KEY":"<redacted>"/u);
  assert.match(text, /"auth":"<redacted>"/u);
});

test('打码是深拷贝：不改动传入对象（避免打码污染实际运行配置）', () => {
  const args = { apiKey: 'sk-live-SECRET', nested: { token: 'tok-1' } };
  DumpRedactor.redact(args);
  assert.strictEqual(args.apiKey, 'sk-live-SECRET');
  assert.strictEqual(args.nested.token, 'tok-1');
});
