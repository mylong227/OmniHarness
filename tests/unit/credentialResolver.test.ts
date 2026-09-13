import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialResolver } from '../../src/config/credentialResolver.js';
import type { VaultPort } from '../../src/ports/memory/vault.js';

/** 内存保险库桩：记录读取次数，可注入失败，用于验证解析链的优先级与 fail-closed 行为。 */
class StubVault implements VaultPort {
  /** 端口名（契约要求）。 */
  public readonly name = 'stub';
  /** 凭据表（名 → 值；值为 undefined 表示不存在）。 */
  private readonly secrets = new Map<string, string>();
  /** getSecret 被调用的名字序列（用于断言「env 命中时绝不查库」）。 */
  public readonly reads: string[] = [];
  /** 置为非 undefined 时 getSecret 直接抛出该消息（模拟密钥错误/后端不可用）。 */
  public failure: string | undefined;

  /**
   * 预置一条凭据。
   * @param name 凭据名。
   * @param value 凭据值。
   * @returns 无
   */
  public seed(name: string, value: string): void {
    this.secrets.set(name, value);
  }

  /**
   * 读取凭据（记录调用）。
   * @param name 凭据名。
   * @returns 凭据值；不存在返回 undefined。
   */
  public async getSecret(name: string): Promise<string | undefined> {
    this.reads.push(name);
    if (this.failure !== undefined) {
      throw new Error(this.failure);
    }
    return this.secrets.get(name);
  }

  /**
   * 写入凭据。
   * @param name 凭据名。
   * @param value 凭据值。
   * @returns 无
   */
  public async setSecret(name: string, value: string): Promise<void> {
    this.secrets.set(name, value);
  }

  /**
   * 删除凭据。
   * @param name 凭据名。
   * @returns 是否删除成功。
   */
  public async deleteSecret(name: string): Promise<boolean> {
    return this.secrets.delete(name);
  }

  /**
   * 判断凭据是否存在。
   * @param name 凭据名。
   * @returns 存在返回 true。
   */
  public async hasSecret(name: string): Promise<boolean> {
    return this.secrets.has(name);
  }

  /**
   * 列出全部凭据名。
   * @returns 凭据名数组。
   */
  public async listSecrets(): Promise<readonly string[]> {
    return [...this.secrets.keys()];
  }

  /**
   * 关闭（桩无资源）。
   * @returns 无
   */
  public async close(): Promise<void> {
    return undefined;
  }
}

/** 在隔离环境变量下跑断言，结束后恢复原值（无论成功失败）。 */
async function withEnv(keys: readonly string[], fn: () => Promise<void>): Promise<void> {
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

test('CredentialResolver：未配置 vault 时解析链退化为纯环境变量（零行为变更）', async () => {
  const resolver = new CredentialResolver(undefined);
  assert.strictEqual(resolver.hasVault, false);
  await withEnv(['OMNI_TEST_KEY'], async () => {
    process.env.OMNI_TEST_KEY = 'from-env';
    assert.strictEqual(await resolver.resolve('OMNI_TEST_KEY'), 'from-env');
    assert.deepStrictEqual(await resolver.hydrateEnv(['OMNI_TEST_KEY']), []);
  });
});

test('CredentialResolver：环境变量优先——已设置项绝不查库、绝不覆盖', async () => {
  const vault = new StubVault();
  vault.seed('OMNI_TEST_KEY', 'from-vault');
  const resolver = new CredentialResolver(vault);
  await withEnv(['OMNI_TEST_KEY'], async () => {
    process.env.OMNI_TEST_KEY = 'from-env';
    assert.deepStrictEqual(await resolver.hydrateEnv(['OMNI_TEST_KEY']), []);
    assert.strictEqual(process.env.OMNI_TEST_KEY, 'from-env');
    assert.deepStrictEqual(vault.reads, [], 'env 已命中时不得查库');
    assert.strictEqual(await resolver.resolve('OMNI_TEST_KEY'), 'from-env');
  });
});

test('CredentialResolver：env 未设置时回退保险库，返回被填充名单', async () => {
  const vault = new StubVault();
  vault.seed('OMNI_TEST_KEY', 'from-vault');
  const resolver = new CredentialResolver(vault);
  await withEnv(['OMNI_TEST_KEY'], async () => {
    assert.deepStrictEqual(await resolver.hydrateEnv(['OMNI_TEST_KEY']), ['OMNI_TEST_KEY']);
    assert.strictEqual(process.env.OMNI_TEST_KEY, 'from-vault');
    assert.deepStrictEqual(vault.reads, ['OMNI_TEST_KEY']);
  });
});

test('CredentialResolver：库中空串不算命中（不写入空值环境变量）', async () => {
  const vault = new StubVault();
  vault.seed('OMNI_TEST_KEY', '');
  const resolver = new CredentialResolver(vault);
  await withEnv(['OMNI_TEST_KEY'], async () => {
    assert.deepStrictEqual(await resolver.hydrateEnv(['OMNI_TEST_KEY']), []);
    assert.strictEqual(process.env.OMNI_TEST_KEY, undefined);
    // resolve 只做「有值就返回」，空串原样回传（由调用方决定是否视为缺失）。
    assert.strictEqual(await resolver.resolve('OMNI_TEST_KEY'), '');
  });
});

test('CredentialResolver：库中无此凭据时既不报错也不写入', async () => {
  const vault = new StubVault();
  const resolver = new CredentialResolver(vault);
  await withEnv(['OMNI_TEST_KEY'], async () => {
    assert.deepStrictEqual(await resolver.hydrateEnv(['OMNI_TEST_KEY']), []);
    assert.strictEqual(await resolver.resolve('OMNI_TEST_KEY'), undefined);
  });
});

test('CredentialResolver：保险库读取失败必须上抛（fail-closed，不得静默降级）', async () => {
  const vault = new StubVault();
  vault.failure = '保险库主密钥不可用';
  const resolver = new CredentialResolver(vault);
  await withEnv(['OMNI_TEST_KEY'], async () => {
    await assert.rejects(() => resolver.hydrateEnv(['OMNI_TEST_KEY']), /保险库主密钥不可用/);
    await assert.rejects(() => resolver.resolve('OMNI_TEST_KEY'), /保险库主密钥不可用/);
    assert.strictEqual(process.env.OMNI_TEST_KEY, undefined);
  });
});

test('CredentialResolver：多名字混合场景只填充缺失项', async () => {
  const vault = new StubVault();
  vault.seed('OMNI_A', 'a-vault');
  vault.seed('OMNI_B', 'b-vault');
  const resolver = new CredentialResolver(vault);
  await withEnv(['OMNI_A', 'OMNI_B'], async () => {
    process.env.OMNI_A = 'a-env';
    assert.deepStrictEqual(await resolver.hydrateEnv(['OMNI_A', 'OMNI_B']), ['OMNI_B']);
    assert.strictEqual(process.env.OMNI_A, 'a-env');
    assert.strictEqual(process.env.OMNI_B, 'b-vault');
    assert.deepStrictEqual(vault.reads, ['OMNI_B'], '已命中的名字不应触发查库');
  });
});
