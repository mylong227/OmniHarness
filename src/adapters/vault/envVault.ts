import type { VaultPort } from '../../ports/vault.js';

/**
 * 环境变量凭据适配器：直接读进程环境变量，写操作记录到内存（不落盘）。
 *
 * 用作未配置加密密钥时的免落盘回退：读取为真实环境变量源（例如
 * `OMNIHARNESS_CRED_<NAME>`），写/删仅作用于进程内映射，便于临时覆盖与测试。
 */
export class EnvVault implements VaultPort {
  public readonly name = 'env';

  private readonly prefix: string;
  private readonly overrides = new Map<string, string>();
  private readonly removed = new Set<string>();

  public constructor(options: { envPrefix?: string } = {}) {
    this.prefix = options.envPrefix ?? 'OMNIHARNESS_CRED_';
  }

  private envKey(name: string): string {
    return `${this.prefix}${name.toUpperCase()}`;
  }

  public async getSecret(name: string): Promise<string | undefined> {
    if (this.removed.has(name)) {
      return undefined;
    }
    if (this.overrides.has(name)) {
      return this.overrides.get(name);
    }
    return process.env[this.envKey(name)];
  }

  public async setSecret(name: string, value: string): Promise<void> {
    this.overrides.set(name, value);
    this.removed.delete(name);
  }

  public async deleteSecret(name: string): Promise<boolean> {
    const existed = this.overrides.has(name) || process.env[this.envKey(name)] !== undefined;
    this.overrides.delete(name);
    this.removed.add(name);
    return existed;
  }

  public async hasSecret(name: string): Promise<boolean> {
    if (this.removed.has(name)) {
      return false;
    }
    return this.overrides.has(name) || process.env[this.envKey(name)] !== undefined;
  }

  public async listSecrets(): Promise<readonly string[]> {
    const names = new Set<string>(this.overrides.keys());
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(this.prefix)) {
        names.add(key.slice(this.prefix.length).toLowerCase());
      }
    }
    this.removed.forEach((name) => names.delete(name));
    return [...names].sort();
  }

  public async close(): Promise<void> {
    // 无底层资源
  }
}
