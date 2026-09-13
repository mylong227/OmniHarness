import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliBuildConfig } from '../../src/cli/cliBuildConfig.js';
import type { CredentialHydrationArgs } from '../../src/cli/cliBuildConfig.js';
import { CryptoVault } from '../../src/adapters/vault/cryptoVault.js';
import { JsonFileKv } from '../../src/adapters/kv/jsonFileKv.js';

/** 暴露受保护装配钩子的测试子类（只做可见性提升，不改变任何行为）。 */
class ProbeBuildConfig extends CliBuildConfig {
  /**
   * 调用受保护的凭据水合。
   * @param args 水合参数子集。
   * @returns 被水合的凭据名列表。
   */
  public async hydrate(args: CredentialHydrationArgs): Promise<readonly string[]> {
    return this.hydrateCredentials(args);
  }
}

/**
 * 在指定环境变量被清空的前提下跑断言，结束后恢复原值（无论成功失败）。
 * @param keys 需要清空并恢复的环境变量名。
 * @param fn 断言体。
 * @returns 无
 */
async function withCleanEnv(keys: readonly string[], fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('装配链：--vault-hydrate 把加密保险库凭据水合进进程环境', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hydrate-'));
  const kvFile = join(dir, 'vault.json');
  const keyFile = join(dir, 'vault.key');
  try {
    await withCleanEnv(['OMNIHARNESS_VAULT_KEY', 'OPENAI_API_KEY'], async () => {
      // 先按 vault 子命令同构的方式写入凭据，再经装配链读回（写读两侧独立构造）。
      const writer = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile });
      await writer.setSecret('OPENAI_API_KEY', 'sk-from-vault');
      await writer.close();

      const filled = await new ProbeBuildConfig().hydrate({
        vaultHydrate: true,
        vaultKeyFile: keyFile,
        kvAdapter: 'json-file',
        kvFile,
      });

      assert.deepStrictEqual(filled, ['OPENAI_API_KEY']);
      assert.strictEqual(process.env.OPENAI_API_KEY, 'sk-from-vault');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('装配链：未开 --vault-hydrate 时零行为变更（不建保险库、不动环境、不落密钥）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hydrate-off-'));
  const keyFile = join(dir, 'vault.key');
  try {
    await withCleanEnv(['OMNIHARNESS_VAULT_KEY', 'OPENAI_API_KEY'], async () => {
      const filled = await new ProbeBuildConfig().hydrate({});
      assert.deepStrictEqual(filled, []);
      assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
      // 缺省关时连保险库都不构造：既不该凭空生成密钥文件。
      assert.strictEqual(existsSync(keyFile), false);
      assert.deepStrictEqual(readdirSync(dir), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('装配链：开了水合但缺主密钥来源时显式跳过（不抛错、不落任何文件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hydrate-nokey-'));
  const kvFile = join(dir, 'vault.json');
  try {
    await withCleanEnv(['OMNIHARNESS_VAULT_KEY', 'OPENAI_API_KEY'], async () => {
      const filled = await new ProbeBuildConfig().hydrate({ vaultHydrate: true, kvFile });
      assert.deepStrictEqual(filled, []);
      assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
      // CryptoVault 在无密钥来源时会「自动生成并持久化」密钥文件——该路径必须先被拦住。
      assert.deepStrictEqual(readdirSync(dir), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('装配链：--vault-hydrate-names 指定名字时只水合这些名字', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hydrate-names-'));
  const kvFile = join(dir, 'vault.json');
  const keyFile = join(dir, 'vault.key');
  try {
    await withCleanEnv(['OMNIHARNESS_VAULT_KEY', 'OPENAI_API_KEY', 'CUSTOM_KEY'], async () => {
      const writer = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile });
      await writer.setSecret('CUSTOM_KEY', 'custom-secret');
      await writer.setSecret('OPENAI_API_KEY', 'sk-should-not-be-hydrated');
      await writer.close();

      const filled = await new ProbeBuildConfig().hydrate({
        vaultHydrate: true,
        vaultHydrateNames: ['CUSTOM_KEY'],
        vaultKeyFile: keyFile,
        kvFile,
      });

      assert.deepStrictEqual(filled, ['CUSTOM_KEY']);
      assert.strictEqual(process.env.CUSTOM_KEY, 'custom-secret');
      assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('装配链：环境变量已显式设置时水合不覆盖（显式配置优先）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hydrate-envfirst-'));
  const kvFile = join(dir, 'vault.json');
  const keyFile = join(dir, 'vault.key');
  try {
    await withCleanEnv(['OMNIHARNESS_VAULT_KEY'], async () => {
      const writer = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile });
      await writer.setSecret('OPENAI_API_KEY', 'sk-from-vault');
      await writer.close();

      process.env.OPENAI_API_KEY = 'sk-from-env';
      try {
        const filled = await new ProbeBuildConfig().hydrate({
          vaultHydrate: true,
          vaultKeyFile: keyFile,
          kvFile,
        });
        assert.deepStrictEqual(filled, []);
        assert.strictEqual(process.env.OPENAI_API_KEY, 'sk-from-env');
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('装配链：保险库主密钥错误时上抛（fail-closed，不静默降级为空凭据）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hydrate-badkey-'));
  const kvFile = join(dir, 'vault.json');
  const keyFile = join(dir, 'vault.key');
  const otherKeyFile = join(dir, 'other.key');
  try {
    await withCleanEnv(['OMNIHARNESS_VAULT_KEY', 'OPENAI_API_KEY'], async () => {
      const writer = new CryptoVault({ kv: new JsonFileKv(kvFile), keyFile });
      await writer.setSecret('OPENAI_API_KEY', 'sk-from-vault');
      await writer.close();
      // 用不同主密钥打开同一份密文：GCM 认证失败，必须抛出而非返回「凭据不存在」。
      const probe = new ProbeBuildConfig();
      await assert.rejects(() =>
        probe.hydrate({ vaultHydrate: true, vaultKeyFile: otherKeyFile, kvFile }),
      );
      assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
