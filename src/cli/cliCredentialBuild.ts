/**
 * CliCredentialBuild —— ExecCli 命令族继承链的**新根基类**（god-class 拆分 · 第 0/6 层，2026-10-11）。
 *
 * ## 为什么单独成层
 *
 * 加上 Web 交付的 buildServeVault 后，CliBuildConfig 越过编码标准的**上帝类**阈值（702 行 / 26 方法）。
 * 处置是按职责外移（本层职责：把凭据来源装配成 VaultPort、并在需要时把凭据水合进环境），
 * 而不是放宽阈值——本仓惯例一贯如此（cliFlagTable / cliValueFlags 也是这么分出去的）。
 *
 * 继承链：`CliCredentialBuild` ← `CliBuildConfig` ← `CliServerCmds` ← …；调用点零改动。
 * 两个方法都不依赖 `this` 的其它成员，故可干净外移。
 */
import { CryptoVault } from '../adapters/vault/cryptoVault.js';
import { CredentialResolver } from '../config/credentialResolver.js';
import { KvStoreFactory } from './kvStoreFactory.js';
import { VaultKeyDefaults } from './vaultKeyDefaults.js';
import type { VaultPort } from '../ports/memory/vault.js';

/** 凭据水合所需的最小参数集（原属 cliBuildConfig，随方法一并外移）。 */
export interface CredentialHydrationArgs {
  /** 是否开启凭据水合（`--vault-hydrate`）。 */
  readonly vaultHydrate?: boolean | undefined;
  /** 要水合的凭据名（缺省用内建默认集）。 */
  readonly vaultHydrateNames?: readonly string[] | undefined;
  /** 保险库主密钥文件（`--vault-key-file`；主密钥优先取 OMNIHARNESS_VAULT_KEY）。 */
  readonly vaultKeyFile?: string | undefined;
  /** KV 后端（密文落盘位置）。 */
  readonly kvAdapter?: 'memory' | 'json-file' | 'sqlite' | undefined;
  /** KV 文件路径（json-file / sqlite 后端用）。 */
  readonly kvFile?: string | undefined;
}

/** 默认水合凭据名（与原 cliBuildConfig 同口径；随方法一并外移）。 */
const DEFAULT_CREDENTIAL_NAMES: readonly string[] = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

/** 凭据构造根类。 */
export class CliCredentialBuild {
  /**
   * 构造 serve（Web UI）用的凭据保险库。
   *
   * 2026-10-11 改口径：**默认就有主密钥来源**（用户级默认密钥文件 `~/.omniharness/vault.key`，
   * 首次使用时生成，0600）。此前"没设环境变量也没给 `--vault-key-file`"时这里**拒绝注入**并打印
   * `凭据保险库未接线` —— 因为 `CryptoVault` 在无密钥文件配置时会用**内存随机密钥**且不落盘，
   * 注入进去只会得到一个"能用但永远读空"的保险库（写下的密文进程一退就永久读不回）。
   * 现在默认密钥文件把这个 footgun 去掉了，于是可以正常接线，启动横幅也如实报**密钥来源**。
   *
   * 优先级：`OMNIHARNESS_VAULT_KEY` > `--vault-key-file` > 默认密钥文件。
   * 显式关闭：`OMNIHARNESS_VAULT=0`（不建任何密钥文件；Web 端如实显示"未接线"）。
   *
   * @param args 已解析参数（取 `vaultKeyFile` / `kvAdapter` / `kvFile`）。
   * @returns 凭据端口；被显式关闭时为 undefined。
   */
  protected async buildServeVault(args: CredentialHydrationArgs): Promise<VaultPort | undefined> {
    if (VaultKeyDefaults.disabledByEnv()) {
      process.stderr.write(
        'ℹ️ 凭据保险库已按 OMNIHARNESS_VAULT=0 关闭（Web 端会如实显示未接线，且不会创建密钥文件）\n',
      );
      return undefined;
    }
    const keyFile = VaultKeyDefaults.resolveKeyFile(args.vaultKeyFile);
    process.stderr.write(
      `🔐 凭据保险库已接线：主密钥来自${VaultKeyDefaults.describeSource(args.vaultKeyFile)}\n`,
    );
    const kv = await new KvStoreFactory().createFor(args.kvAdapter, args.kvFile);
    return new CryptoVault({ kv, keyFile });
  }

  /**
   * F3 凭据水合：把加密保险库中的凭据接进生产凭据链。
   *
   * 背景：`VaultPort`（CryptoVault）此前只被 `vault` 子命令使用，而模型适配器与模型路由
   * 都硬读 `process.env`——保险库里存的凭据在生产路径上无人读取。本方法补上这段接线：
   * **环境变量优先、保险库回退**（仅填充未设置项，绝不覆盖显式配置）。
   *
   * 缺省（未开 `--vault-hydrate`）直接返回空名单 = **零行为变更**。保险库读取失败时上抛
   * （fail-closed：显式要求水合却读不动，不得静默降级成「凭据不存在」）。
   *
   * 2026-10-12 口径变更（修掉一处**半接线**）：此前这里要求「环境变量或 `--vault-key-file`
   * 二选一」，否则跳过——而 `buildServeVault` 已随默认密钥文件（`VaultKeyDefaults`）默认接线，
   * 于是同一进程里出现两种口径：`serve` 能读写保险库，`--vault-hydrate` 却一句「缺少主密钥
   * 来源」跳过了事（实测：保险库里就存着 `OPENAI_API_KEY` 也照样跳过）。现在两边共用同一套
   * 主密钥来源解析；`OMNIHARNESS_VAULT=0` 一并跳过。
   *
   * @param args 水合参数子集（vaultHydrate / vaultHydrateNames / vaultKeyFile / kvAdapter / kvFile）。
   * @returns 实际被水合的凭据名列表（未开启水合、保险库被关闭或无命中时为空）。
   * @throws 保险库读取失败时上抛（含主密钥来源，便于判「是不是密钥换了」）。
   */
  protected async hydrateCredentials(args: CredentialHydrationArgs): Promise<readonly string[]> {
    if (args.vaultHydrate !== true) {
      return [];
    }
    if (VaultKeyDefaults.disabledByEnv()) {
      process.stderr.write(
        'ℹ️ --vault-hydrate 已按 OMNIHARNESS_VAULT=0 跳过（该开关关闭了整个凭据保险库）\n',
      );
      return [];
    }
    // 与 buildServeVault 共用同一套解析：无显式 --vault-key-file 时落到用户级默认密钥文件，
    // 否则这里会退化成 `keyFile: undefined` ⇒ CryptoVault 用内存随机密钥 ⇒ 永远读空（半接线）。
    const keyFile = VaultKeyDefaults.resolveKeyFile(args.vaultKeyFile);
    const kv = await new KvStoreFactory().createFor(args.kvAdapter, args.kvFile);
    const vault = new CryptoVault({ kv, keyFile });
    try {
      const names = args.vaultHydrateNames ?? DEFAULT_CREDENTIAL_NAMES;
      const filled = await new CredentialResolver(vault).hydrateEnv(names);
      if (filled.length > 0) {
        process.stderr.write(`🔐 已从凭据保险库水合 ${filled.length} 项: ${filled.join(', ')}\n`);
      }
      return filled;
    } catch (error) {
      // fail-closed 不变，但把密码学真相翻成人话：换主密钥后旧密文本就不可读，宁可报错也不冒充"没存过"。
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `--vault-hydrate 读取凭据失败（在此停住，不静默降级为"凭据不存在"）：主密钥来自` +
          `${VaultKeyDefaults.describeSource(args.vaultKeyFile)}；换了密钥来源后，` +
          `先前用别的密钥写下的密文必然解不开（GCM 认证失败）。原始错误：${detail}`,
      );
    } finally {
      await vault.close();
    }
  }
}
