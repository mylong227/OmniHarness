import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KvPort } from '../../ports/memory/kv.js';
import type { VaultPort } from '../../ports/memory/vault.js';

/** 单条密文载荷结构（base64，冒号分隔）：iv : ciphertext : authTag。 */
type CipherPayload = { iv: string; cipher: string; tag: string };

/**
 * 加密凭据适配器：AES-256-GCM 加密后写入底层 KV，主密钥按级联解析：
 *   1. 环境变量 `OMNIHARNESS_VAULT_KEY`（推荐，不落盘）
 *   2. 密钥文件（`--vault-key-file`，权限 0600）
 *   3. 自动生成随机密钥并持久化到密钥文件（首次使用）
 * 满足"node:crypto 加密存储 + 环境变量回退"，可复用任意 {@link KvPort} 后端。
 */
export class CryptoVault implements VaultPort {
  /** 端口名：加密凭据后端标识，与 VaultPort 契约的适配器命名空间一致。 */
  public readonly name = 'crypto';

  /** 底层键值存储端口：密文实际落盘位置。 */
  private readonly kv: KvPort;
  /** 密钥文件路径（主密钥来源优先级 2/3）；未配置则无文件回退。 */
  private readonly keyFile?: string | undefined;
  /** 主密钥来源优先级 1 的环境变量名。 */
  private readonly envVar: string;
  /** 已解析的 32 字节主密钥缓存（懒加载，避免重复读环境变量/文件）。 */
  private key: Buffer | undefined;
  /** 密文载荷缓存：凭据名 → iv/cipher/tag，避免重复读 KV。 */
  private readonly cache = new Map<string, CipherPayload>();

  public constructor(options: {
    /** 底层键值存储端口：密文实际落盘位置。 */
    kv: KvPort;
    /** 主密钥来源优先级 1（默认 `OMNIHARNESS_VAULT_KEY`）。 */
    envVar?: string;
    /** 主密钥来源优先级 2/3 的密钥文件（省略则无文件回退）。 */
    keyFile?: string | undefined;
  }) {
    this.kv = options.kv;
    this.envVar = options.envVar ?? 'OMNIHARNESS_VAULT_KEY';
    this.keyFile = options.keyFile;
  }

  /** 解析 32 字节 AES-256 主密钥。
   * @returns 主密钥（优先环境变量，其次密钥文件，均无则自动生成并持久化到密钥文件）。
   */
  private async getKey(): Promise<Buffer> {
    if (this.key !== undefined) {
      return this.key;
    }
    const fromEnv = process.env[this.envVar];
    if (fromEnv && fromEnv.length > 0) {
      this.key = this.deriveKey(fromEnv);
      return this.key;
    }
    if (this.keyFile !== undefined) {
      try {
        const raw = (await fs.readFile(this.keyFile, 'utf8')).trim();
        if (raw.length > 0) {
          this.key = this.deriveKey(raw);
          return this.key;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    // 自动生成并持久化随机密钥（首次使用）。
    const generated = randomBytes(32).toString('hex');
    if (this.keyFile !== undefined) {
      await fs.mkdir(path.dirname(this.keyFile), { recursive: true });
      await fs.writeFile(this.keyFile, generated, { mode: 0o600 });
    }
    this.key = this.deriveKey(generated);
    return this.key;
  }

  /** 从可读口令派生定长密钥（SHA-256）。
   * @param secret 可读口令（环境变量内容、密钥文件内容或随机生成串）。
   * @returns 32 字节派生密钥。
   */
  private deriveKey(secret: string): Buffer {
    return createHash('sha256').update(secret, 'utf8').digest();
  }

  /** 解析 `iv:cipher:tag` 三段式密文载荷。
   * @param raw 从 KV 读出的 base64 密文串。
   * @returns 拆分后的载荷对象。
   * @throws 段数不足（格式损坏）时抛错，绝不带错误数据继续。
   */
  private parsePayload(raw: string): CipherPayload {
    const [iv, cipher, tag] = raw.split(':');
    if (iv === undefined || cipher === undefined || tag === undefined) {
      throw new Error(`凭据密文格式损坏: ${raw.slice(0, 8)}...`);
    }
    return { iv, cipher, tag };
  }

  /** 读单条密文（带缓存）。
   * @param name 凭据名（KV 键）。
   * @returns 缓存或 KV 中的密文载荷；KV 无此条目返回 undefined。
   */
  private async readPayload(name: string): Promise<CipherPayload | undefined> {
    const hit = this.cache.get(name);
    if (hit !== undefined) {
      return hit;
    }
    const raw = await this.kv.get(name);
    if (raw === undefined) {
      return undefined;
    }
    const payload = this.parsePayload(raw);
    this.cache.set(name, payload);
    return payload;
  }

  /** 将密文载荷以 `iv:cipher:tag` 串写入 KV 并刷新本地缓存。
   * @param name 凭据名（KV 键）。
   * @param payload 待写入的 iv/cipher/tag 载荷。
   * @returns 无返回值。
   */
  private async writePayload(name: string, payload: CipherPayload): Promise<void> {
    await this.kv.set(name, `${payload.iv}:${payload.cipher}:${payload.tag}`);
    this.cache.set(name, payload);
  }

  /**
   * 读取凭据并 AES-256-GCM 解密。
   * @param name 凭据名（即底层 KV 的键）。
   * @returns 解密后的明文；底层 KV 无此条目返回 undefined。
   * @throws 密文格式损坏或 GCM 认证标签校验失败时抛错（fail-closed，不返回错误明文）。
   */
  public async getSecret(name: string): Promise<string | undefined> {
    const payload = await this.readPayload(name);
    if (payload === undefined) {
      return undefined;
    }
    const key = await this.getKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.cipher, 'base64')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  }

  /**
   * 写入（或覆盖）凭据：每次生成随机 12 字节 IV，AES-256-GCM 加密后以
   * `iv:cipher:tag` 密文落入底层 KV，并刷新本地明文密文缓存。
   * @param name 凭据名。
   * @param value 明文值。
   * @returns 无返回值。
   */
  public async setSecret(name: string, value: string): Promise<void> {
    const key = await this.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
    await this.writePayload(name, {
      iv: iv.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
  }

  /**
   * 删除凭据：委托底层 KV 删除，并同步失效本地缓存条目。
   * @param name 凭据名。
   * @returns 存在且删除成功返回 true，不存在返回 false。
   */
  public async deleteSecret(name: string): Promise<boolean> {
    const existed = await this.kv.delete(name);
    this.cache.delete(name);
    return existed;
  }

  /** 凭据是否存在（仅查底层 KV 是否有该键，不解密）。
   * @param name 凭据名（KV 键）。
   * @returns 底层 KV 存在该键时为 true。
   */
  public async hasSecret(name: string): Promise<boolean> {
    return this.kv.has(name);
  }

  /** 列出全部凭据名（即底层 KV 全部键，不泄露值）。
   * @returns 全部凭据名列表。
   */
  public async listSecrets(): Promise<readonly string[]> {
    return this.kv.keys();
  }

  /** 清空明文缓存与主密钥引用并关闭底层 KV（不删除密钥文件）。
   * @returns 无返回值。
   */
  public async close(): Promise<void> {
    this.cache.clear();
    this.key = undefined;
    await this.kv.close();
  }
}
