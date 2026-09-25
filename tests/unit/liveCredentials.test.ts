import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUserProviderKey, userConfigPath } from '../../src/eval/liveCredentials.js';

/** 新建临时用户配置目录。 */
function home(): string {
  return mkdtempSync(join(tmpdir(), 'omni-livecred-'));
}

test('用户级凭据：providerKeys 命中 → 返回密钥字符串', () => {
  const dir = home();
  writeFileSync(
    join(dir, 'omniharness.json'),
    JSON.stringify({ providerKeys: { deepseek: 'sk-fixture-key' } }),
    'utf8',
  );
  assert.strictEqual(
    readUserProviderKey({ userConfigPath: join(dir, 'omniharness.json') }),
    'sk-fixture-key',
  );
});

test('用户级凭据：文件缺失 → undefined（fail-closed，不抛错）', () => {
  const dir = home();
  assert.strictEqual(readUserProviderKey({ userConfigPath: join(dir, 'absent.json') }), undefined);
});

test('用户级凭据：非法 JSON / 顶层非对象 / 缺 providerKeys / 值缺型 → 一律 undefined', () => {
  const dir = home();
  const cases: readonly string[] = [
    '{not-json',
    '"just-a-string"',
    '{"other": 1}',
    '{"providerKeys": "nope"}',
    '{"providerKeys": {"deepseek": 42}}',
    '{"providerKeys": {"deepseek": ""}}',
    '{"providerKeys": {"deepseek": null}}',
  ];
  for (const [i, raw] of cases.entries()) {
    const p = join(dir, `case-${i}.json`);
    writeFileSync(p, raw, 'utf8');
    assert.strictEqual(readUserProviderKey({ userConfigPath: p }), undefined, `case#${i}: ${raw}`);
  }
});

test('用户级凭据：provider 名可注入（非 deepseek 键同样可读）', () => {
  const dir = home();
  const p = join(dir, 'omniharness.json');
  writeFileSync(p, JSON.stringify({ providerKeys: { openai: 'sk-openai-fixture' } }), 'utf8');
  assert.strictEqual(
    readUserProviderKey({ userConfigPath: p, provider: 'openai' }),
    'sk-openai-fixture',
  );
  assert.strictEqual(
    readUserProviderKey({ userConfigPath: p }),
    undefined,
    '缺省 deepseek 键不存在 → undefined',
  );
});

test('用户级凭据：路径派生与 ConfigFile 用户层同源（homedir/.omniharness/omniharness.json）', () => {
  const dir = home();
  assert.strictEqual(userConfigPath(dir), join(dir, '.omniharness', 'omniharness.json'));
});
