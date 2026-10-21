import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dpapi } from '../../src/util/dpapi.ts';
import { DpapiConfig } from '../../src/config/dpapiConfig.ts';
import { ConfigFile } from '../../src/config/configFile.ts';

test('DPAPI：Windows 上加密/解密往返，且密文不含明文（2026-10-21）', async () => {
  if (process.platform !== 'win32') {
    return;
  }
  const plain = 'sk-dpapi-roundtrip';
  const cipher = Dpapi.protect(plain);
  assert.ok(cipher.length > 0);
  assert.ok(!cipher.includes(plain), '密文不得包含明文');
  assert.strictEqual(Dpapi.unprotect(cipher), plain);
}, 30_000);

test('DPAPI：配置 seal/open 隐去明文，ConfigFile 落盘/读回一致', async () => {
  if (process.platform !== 'win32') {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'omni-dpapi-'));
  try {
    const sealed = DpapiConfig.seal({
      apiKey: 'sk-config-secret',
      providerKeys: { deepseek: 'sk-provider-secret' },
    });
    assert.strictEqual(sealed.apiKey, undefined, '落盘对象不得保留明文 apiKey');
    assert.strictEqual(sealed.providerKeys, undefined, '落盘对象不得保留明文 providerKeys');
    assert.ok(sealed.apiKeyDpapi !== undefined);
    assert.ok(sealed.providerKeysDpapi?.['deepseek'] !== undefined);

    const path = join(dir, 'omniharness.json');
    const file = new ConfigFile();
    file.save(path, {
      apiKey: 'sk-config-secret',
      providerKeys: { deepseek: 'sk-provider-secret' },
    });
    const raw = readFileSync(path, 'utf8');
    assert.doesNotMatch(raw, /sk-config-secret/u, '配置文件不得出现明文 Key');
    assert.doesNotMatch(raw, /sk-provider-secret/u);
    const loaded = file.load(path);
    assert.strictEqual(loaded.apiKey, 'sk-config-secret');
    assert.strictEqual(loaded.providerKeys?.['deepseek'], 'sk-provider-secret');
    assert.strictEqual(loaded.apiKeyDpapi, undefined, '读路径应还原为明文供运行时使用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
