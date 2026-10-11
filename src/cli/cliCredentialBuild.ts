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
   * 构造 serve（Web UI）用的凭据保险库；**无主密钥来源时返回 undefined**（不注入）。
   *
   * 为什么不无脑 new 一个：`CryptoVault` 在没有主密钥时会**随机生成内存密钥**——那既读不到既有密文，
   * 又可能凭空落一个新的密钥文件。若把它注入服务端，Web 面板会显示一个"能用但读到空"的保险库，
   * 用户会以为凭据丢了。故此处显式判定：有来源（环境变量或 `--vault-key-file`）才注入，
   * 否则留空 —— 面板会如实显示"未接线"并提示怎么开（`{ok:false, reason}`，与 doctor/audit 同源）。
   *
   * @param args 已解析参数（取 `vaultKeyFile` / `kvAdapter` / `kvFile`）。
   * @returns 凭据端口；无主密钥来源时为 undefined。
   */
  protected async buildServeVault(args: CredentialHydrationArgs): Promise<VaultPort | undefined> {
    const keyFromEnv = process.env.OMNIHARNESS_VAULT_KEY;
    if ((keyFromEnv === undefined || keyFromEnv.length === 0) && args.vaultKeyFile === undefined) {
      process.stderr.write(
        'ℹ️ 凭据保险库未接线（设 OMNIHARNESS_VAULT_KEY 或 --vault-key-file 后重启即可在 Web 端管理）\n',
      );
      return undefined;
    }
    const kv = await new KvStoreFactory().createFor(args.kvAdapter, args.kvFile);
    return new CryptoVault({ kv, keyFile: args.vaultKeyFile });
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
   * @param args 水合参数子集（vaultHydrate / vaultHydrateNames / vaultKeyFile / kvAdapter / kvFile）。
   * @returns 实际被水合的凭据名列表（未开启水合、缺少主密钥来源或保险库无命中时为空）。
   */
  protected async hydrateCredentials(args: CredentialHydrationArgs): Promise<readonly string[]> {
    if (args.vaultHydrate !== true) {
      return [];
    }
    // 无主密钥来源时 CryptoVault 只会在内存里随机生成密钥：既读不到既有密文，还可能凭空
    // 落下新的密钥文件。此处显式跳过并说明，避免「静默水合 0 项」被误读成「保险库是空的」。
    const keyFromEnv = process.env.OMNIHARNESS_VAULT_KEY;
    if ((keyFromEnv === undefined || keyFromEnv.length === 0) && args.vaultKeyFile === undefined) {
      process.stderr.write(
        '⚠️ --vault-hydrate 缺少主密钥来源（请设 OMNIHARNESS_VAULT_KEY 或 --vault-key-file），已跳过水合\n',
      );
      return [];
    }
    const kv = await new KvStoreFactory().createFor(args.kvAdapter, args.kvFile);
    const vault = new CryptoVault({ kv, keyFile: args.vaultKeyFile });
    try {
      const names = args.vaultHydrateNames ?? DEFAULT_CREDENTIAL_NAMES;
      const filled = await new CredentialResolver(vault).hydrateEnv(names);
      if (filled.length > 0) {
        process.stderr.write(`🔐 已从凭据保险库水合 ${filled.length} 项: ${filled.join(', ')}\n`);
      }
      return filled;
    } finally {
      await vault.close();
    }
  }
}
