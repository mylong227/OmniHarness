import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KvPort } from '../../ports/kv.js';
import type { VaultPort } from '../../ports/vault.js';

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
  public readonly name = 'crypto';

  private readonly kv: KvPort;
  private readonly keyFile?: string;
  private readonly envVar: string;
  private key: Buffer | undefined;
  private readonly cache = new Map<string, CipherPayload>();

  public constructor(options: {
    kv: KvPort;
    /** 主密钥来源优先级 1（默认 `OMNIHARNESS_VAULT_KEY`）。 */
    envVar?: string;
    /** 主密钥来源优先级 2/3 的密钥文件（省略则无文件回退）。 */
    keyFile?: string;
  }) {
    this.kv = options.kv;
    this.envVar = options.envVar ?? 'OMNIHARNESS_VAULT_KEY';
    this.keyFile = options.keyFile;
  }

  /** 解析 32 字节 AES-256 主密钥。 */
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

  /** 从可读口令派生定长密钥（SHA-256）。 */
  private deriveKey(secret: string): Buffer {
    return createHash('sha256').update(secret, 'utf8').digest();
  }

  private parsePayload(raw: string): CipherPayload {
    const [iv, cipher, tag] = raw.split(':');
    if (iv === undefined || cipher === undefined || tag === undefined) {
      throw new Error(`凭据密文格式损坏: ${raw.slice(0, 8)}...`);
    }
    return { iv, cipher, tag };
  }

  /** 读单条密文（带缓存）。 */
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

  private async writePayload(name: string, payload: CipherPayload): Promise<void> {
    await this.kv.set(name, `${payload.iv}:${payload.cipher}:${payload.tag}`);
    this.cache.set(name, payload);
  }

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

  public async deleteSecret(name: string): Promise<boolean> {
    const existed = await this.kv.delete(name);
    this.cache.delete(name);
    return existed;
  }

  public async hasSecret(name: string): Promise<boolean> {
    return this.kv.has(name);
  }

  public async listSecrets(): Promise<readonly string[]> {
    return this.kv.keys();
  }

  public async close(): Promise<void> {
    this.cache.clear();
    this.key = undefined;
    await this.kv.close();
  }
}
