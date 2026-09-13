import type { VaultPort } from '../ports/memory/vault.js';

/**
 * 凭据解析器（F3）：把「进程环境变量」与「加密凭据保险库」接成统一的凭据解析链。
 *
 * 背景：`VaultPort`（`CryptoVault` / `EnvVault`）能力完备，但此前只被 CLI `vault` 子命令使用，
 * 生产凭据链（模型适配器）只硬读 `process.env`——保险库里存的凭据在生产路径上无人读取。
 * 本类补上这段接线：**环境变量优先，保险库回退**，两者皆无则由调用方 fail-closed 报错。
 *
 * 两条使用方式：
 *  - {@link CredentialResolver.hydrateEnv}：装配期一次性把保险库凭据水合进进程环境（供所有按
 *    `process.env.X` 读凭据的下游消费者零改动获得回退源）。**仅填充未设置项**，绝不覆盖显式配置。
 *  - {@link CredentialResolver.resolve}：单次解析（不写环境），供需要显式取值的调用点使用。
 *
 * 安全性：保险库中的凭据以 AES-256-GCM 密文落盘（见 `CryptoVault`），水合只把明文放进**进程内存**，
 * 不产生任何新的落盘；`hydrateEnv` 的副作用仅限于当前进程的环境表。
 */
export class CredentialResolver {
  /** 凭据保险库；未配置时为 undefined（解析链退化为「仅环境变量」，即零行为变更）。 */
  private readonly vault: VaultPort | undefined;

  /**
   * @param vault 凭据保险库端口（未配置 vault 时传 undefined）。
   */
  public constructor(vault: VaultPort | undefined) {
    this.vault = vault;
  }

  /**
   * 把保险库中的凭据水合进进程环境变量（**仅填充未设置项**）。
   *
   * 语义：对每个候选名，若 `process.env[name]` 已有值则**原样保留**（显式配置优先），
   * 否则查保险库；命中非空值才写入环境表并计入返回名单。
   *
   * @param names 候选凭据名（如 `OPENAI_API_KEY`）。
   * @returns 实际被水合的凭据名列表（供上报与断言；无 vault 时恒为空）。
   * @throws 保险库读取失败时上抛（fail-closed：显式配置了保险库却读不动，不得静默降级）。
   */
  public async hydrateEnv(names: readonly string[]): Promise<readonly string[]> {
    if (this.vault === undefined) {
      return [];
    }
    const filled: string[] = [];
    for (const name of names) {
      if (process.env[name] !== undefined) {
        continue;
      }
      const value = await this.vault.getSecret(name);
      if (value !== undefined && value.length > 0) {
        process.env[name] = value;
        filled.push(name);
      }
    }
    return filled;
  }

  /**
   * 解析单个凭据（不写环境表）。
   * @param name 凭据名（即环境变量键，如 `OPENAI_API_KEY`）。
   * @returns 环境变量优先，其次保险库；两者皆无返回 undefined（由调用方决定是否 fail-closed）。
   */
  public async resolve(name: string): Promise<string | undefined> {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined) {
      return fromEnv;
    }
    if (this.vault === undefined) {
      return undefined;
    }
    return this.vault.getSecret(name);
  }

  /** 是否配置了保险库（false 表示解析链退化为纯环境变量）。
   * @returns 配置了 vault 返回 true。
   */
  public get hasVault(): boolean {
    return this.vault !== undefined;
  }
}
