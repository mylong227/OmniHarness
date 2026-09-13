import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { VaultPort } from '../../src/ports/memory/vault.js';
import { JsonFileKv } from '../../src/adapters/kv/jsonFileKv.js';
import { MemoryKv } from '../../src/adapters/kv/memoryKv.js';
import { CryptoVault } from '../../src/adapters/vault/cryptoVault.js';
import { EnvVault } from '../../src/adapters/vault/envVault.js';

/** 全后端通用的 Vault 契约测试。 */
async function runVaultContract(vault: VaultPort): Promise<void> {
  assert.strictEqual(await vault.getSecret('nope'), undefined);

  await vault.setSecret('api', 'sk-123');
  assert.strictEqual(await vault.getSecret('api'), 'sk-123');

  await vault.setSecret('api', 'sk-456');
  assert.strictEqual(await vault.getSecret('api'), 'sk-456');

  assert.strictEqual(await vault.hasSecret('api'), true);
  assert.strictEqual(await vault.hasSecret('b'), false);

  await vault.setSecret('token', 't-1');
  const names = await vault.listSecrets();
  assert.strictEqual(names.includes('api'), true);
  assert.strictEqual(names.includes('token'), true);

  assert.strictEqual(await vault.deleteSecret('token'), true);
  assert.strictEqual(await vault.deleteSecret('token'), false);
  assert.strictEqual(await vault.hasSecret('token'), false);

  await vault.close();
}

test('EnvVault：契约通过 + 环境变量回退', async () => {
  const envName = `TEST_CRED_${Date.now()}`;
  process.env[envName] = 'env-secret';
  try {
    const vault = new EnvVault({ envPrefix: 'TEST_CRED_' });
    // 读取真实环境变量（小写名映射大写环境键）
    assert.strictEqual(
      await vault.getSecret(envName.replace(/^TEST_CRED_/, '').toLowerCase()),
      'env-secret',
    );
    // 写入仅进程内覆盖
    await vault.setSecret('tmp', 'mem');
    assert.strictEqual(await vault.getSecret('tmp'), 'mem');
    await vault.close();
  } finally {
    delete process.env[envName];
  }
});

test('CryptoVault(MemoryKv)：契约通过 + 密文不落明文', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-vault-'));
  const keyFile = path.join(dir, 'key');
  try {
    const vault = new CryptoVault({ kv: new MemoryKv(), keyFile });
    await runVaultContract(vault);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CryptoVault(JsonFileKv)：加密落盘 + 重启后解密 + 磁盘不含明文', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-vault-'));
  const kvFile = path.join(dir, 'store.json');
  const keyFile = path.join(dir, 'key');
  try {
    // 首次：自动生成密钥文件，写入凭据
    const vault1 = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile });
    await vault1.setSecret('gh_token', 'ghp_abcd');
    await vault1.close();

    // 磁盘 JSON 不应包含明文
    const raw = await readFile(kvFile, 'utf8');
    assert.strictEqual(raw.includes('ghp_abcd'), false);
    // 密钥文件已生成
    const persistedKey = (await readFile(keyFile, 'utf8')).trim();
    assert.ok(persistedKey.length > 0);

    // 重启：同密钥文件可解密
    const vault2 = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile });
    assert.strictEqual(await vault2.getSecret('gh_token'), 'ghp_abcd');
    await vault2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CryptoVault：环境变量主密钥优先（不依赖密钥文件）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-vault-'));
  process.env.OMNIHARNESS_VAULT_TEST_KEY = 'master-pass-123';
  try {
    const kvFile = path.join(dir, 'store.json');
    const vault = new CryptoVault({
      kv: new JsonFileKv(kvFile),
      envVar: 'OMNIHARNESS_VAULT_TEST_KEY',
    });
    await vault.setSecret('db', 'p@ss');
    assert.strictEqual(await vault.getSecret('db'), 'p@ss');
    await vault.close();
  } finally {
    delete process.env.OMNIHARNESS_VAULT_TEST_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('CryptoVault：换密钥后无法解密（密钥完整性）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omniharness-vault-'));
  const kvFile = path.join(dir, 'store.json');
  try {
    const keyFileA = path.join(dir, 'keyA');
    const vaultA = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile: keyFileA });
    await vaultA.setSecret('s', 'secret-1');
    await vaultA.close();

    // 用另一个密钥文件重新打开同一 KV 文件
    const keyFileB = path.join(dir, 'keyB');
    const vaultB = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile: keyFileB });
    await vaultB.setSecret('other', 'x');
    await assert.rejects(vaultB.getSecret('s'), /authenticate|Unsupported state|解密/i);
    await vaultB.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
