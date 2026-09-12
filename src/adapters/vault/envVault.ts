import type { VaultPort } from '../../ports/vault.js';

/**
 * 环境变量凭据适配器：直接读进程环境变量，写操作记录到内存（不落盘）。
 *
 * 用作未配置加密密钥时的免落盘回退：读取为真实环境变量源（例如
 * `OMNIHARNESS_CRED_<NAME>`），写/删仅作用于进程内映射，便于临时覆盖与测试。
 */
export class EnvVault implements VaultPort {
  /** 端口名：环境变量后端标识，与 VaultPort 契约的适配器命名空间一致。 */
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

  /**
   * 读取凭据：删除标记优先返回 undefined，其次进程内覆盖值，最后真实环境变量
   * `<前缀><NAME 大写>`。
   * @param name 凭据名（读取时自动转大写拼前缀）。
   * @returns 凭据明文；不存在或已删除返回 undefined。
   */
  public async getSecret(name: string): Promise<string | undefined> {
    if (this.removed.has(name)) {
      return undefined;
    }
    if (this.overrides.has(name)) {
      return this.overrides.get(name);
    }
    return process.env[this.envKey(name)];
  }

  /** 写入进程内覆盖映射并撤销其删除标记（不写真实环境变量，重启即失）。 */
  public async setSecret(name: string, value: string): Promise<void> {
    this.overrides.set(name, value);
    this.removed.delete(name);
  }

  /**
   * 删除凭据：清覆盖值并加入删除标记（仅屏蔽后续读取，不改真实进程环境变量）。
   * @param name 凭据名。
   * @returns 删除前是否存在（覆盖映射或环境变量中有值）。
   */
  public async deleteSecret(name: string): Promise<boolean> {
    const existed = this.overrides.has(name) || process.env[this.envKey(name)] !== undefined;
    this.overrides.delete(name);
    this.removed.add(name);
    return existed;
  }

  /** 凭据是否存在：删除标记一律 false，否则查覆盖映射或环境变量（不解值）。 */
  public async hasSecret(name: string): Promise<boolean> {
    if (this.removed.has(name)) {
      return false;
    }
    return this.overrides.has(name) || process.env[this.envKey(name)] !== undefined;
  }

  /** 列出全部凭据名（覆盖映射 + 带前缀环境变量去除前缀，剔除已删除项，排序返回；不泄露值）。 */
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

  /** 无底层资源，方法为空（仅满足端口契约）。 */
  public async close(): Promise<void> {
    // 无底层资源
  }
}
