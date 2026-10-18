import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliBuildConfig } from '../../src/cli/cliBuildConfig.ts';
import type { CredentialHydrationArgs } from '../../src/cli/cliBuildConfig.ts';
import { CryptoVault } from '../../src/adapters/vault/cryptoVault.ts';
import { JsonFileKv } from '../../src/adapters/kv/jsonFileKv.ts';

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

test('装配链：开了水合但无显式密钥来源时走**用户级默认密钥文件**（2026-10-12 改口径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-hydrate-nokey-'));
  try {
    await withCleanEnv(['OMNIHARNESS_VAULT_KEY', 'OPENAI_API_KEY'], async () => {
      const filled = await new ProbeBuildConfig().hydrate({ vaultHydrate: true });
      assert.deepStrictEqual(filled, [], '空保险库 ⇒ 零命中（不得捏造凭据）');
      assert.strictEqual(process.env.OPENAI_API_KEY, undefined);

      // 旧口径（2026-10-12 前）在这里**直接 return []**：那时担心 CryptoVault 落到内存随机密钥、
      // 既读不到既有密文又凭空写文件。默认密钥文件上线后这个短路就成了半接线——serve 侧按新口径
      // 读写保险库，`--vault-hydrate` 却仍以"缺少主密钥来源"跳过（真跑一遍即可复现）。
      // ⇒ 本判据钉的是"不许再短路"：源码里不得出现那条无条件跳过分支。
      const source = readFileSync(join(process.cwd(), 'src/cli/cliCredentialBuild.ts'), 'utf8');
      assert.doesNotMatch(
        source,
        /缺少主密钥来源/u,
        'hydrateCredentials 不得再因"无显式主密钥来源"而短路（半接线）',
      );
      assert.match(
        source,
        /hydrateCredentials[\s\S]{0,600}?VaultKeyDefaults\.resolveKeyFile/u,
        '水合必须与 serve 走同一套主密钥来源解析',
      );
      // 正对照：把"解析主密钥"换成一个不存在的调用却仍检不出 ⇒ 上面的断言是空的。
      // 必须**全部**替换：`serve` 与水合两处都走这个解析，只替换一处时另一处仍在 ⇒ 变异不落地。
      const mutated = source
        .split('VaultKeyDefaults.resolveKeyFile(args.vaultKeyFile)')
        .join('undefinedKeyFile(args.vaultKeyFile)');
      assert.notStrictEqual(mutated, source, '正对照变异未落地');
      assert.doesNotMatch(
        mutated,
        /hydrateCredentials[\s\S]{0,600}?VaultKeyDefaults\.resolveKeyFile/u,
        '去掉共用解析却检不出来 ⇒ 本判据恒真',
      );
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
      await assert.rejects(
        () => probe.hydrate({ vaultHydrate: true, vaultKeyFile: otherKeyFile, kvFile }),
        // 2026-10-12：抛出时必须带上"主密钥来自哪里"——否则用户只看到一句 GCM 报错，
        // 判断不出是「密钥换了」还是「凭据没存过」。
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return message.includes('主密钥来自') && message.includes(otherKeyFile);
        },
        '失败消息必须可行动（点明主密钥来源 + 换密钥后旧密文本就解不开）',
      );
      assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
