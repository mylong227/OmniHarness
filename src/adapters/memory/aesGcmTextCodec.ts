import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @beta
 * 文本编解码器：把明文文本转换为可落盘的字符串（如加密）。
 */
export interface TextCodec {
  /** 编码（加密/转义）为可落盘字符串。 */
  encode(text: string): string;
  /** 解码（解密/还原）回明文。 */
  decode(text: string): string;
}

/**
 * @beta
 * AES-256-GCM 文本编解码器（#S28/4.4，与 {@link CryptoVault} 同级密码学强度）。
 *
 * 设计要点：
 * - 每条文本**独立加密**（随机 12 字节 iv），因此底层存储可逐行 append-only，
 *   加密不破坏 `FileLongTermMemory` 的崩溃安全不变量。
 * - 主密钥解析级联（与 CryptoVault 一致）：环境变量 `OMNIHARNESS_MEMORY_KEY`
 *   → 密钥文件（首次使用自动生成并 0600 落盘）→ 兜底随机（仅进程内存，重启即失，不推荐）。
 * - 密文载荷：`iv(base64):cipher(base64):tag(base64)`，单字符串，适合逐行 JSONL 存储。
 */
export class AesGcmTextCodec implements TextCodec {
  /** 编解码器名称（标识此 AES-256-GCM 实现）。 */
  public readonly name = 'aes-256-gcm';

  /** 主密钥来源优先级 1 的环境变量名。 */
  private readonly envVar: string;
  /** 主密钥来源优先级 2 的密钥文件路径（首次使用自动生成并 0600 落盘）。 */
  private readonly keyFile?: string | undefined;
  /** 已解析的 32 字节主密钥缓存（懒加载，避免重复读环境变量/文件）。 */
  private key: Buffer | undefined;

  /**
   * @param options 编解码器选项（环境变量名与密钥文件路径，均有默认）。
   */
  public constructor(options?: { envVar?: string; keyFile?: string }) {
    this.envVar = options?.envVar ?? 'OMNIHARNESS_MEMORY_KEY';
    this.keyFile = options?.keyFile;
  }

  /** 解析 32 字节 AES-256 主密钥（带缓存）。
   * @returns 主密钥（环境变量 → 密钥文件 → 兜底随机的级联结果）。
   */
  private resolveKey(): Buffer {
    if (this.key !== undefined) {
      return this.key;
    }
    const fromEnv = process.env[this.envVar];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      this.key = this.derive(fromEnv);
      return this.key;
    }
    if (this.keyFile !== undefined) {
      if (existsSync(this.keyFile)) {
        const raw = readFileSync(this.keyFile, 'utf8').trim();
        if (raw.length > 0) {
          this.key = this.derive(raw);
          return this.key;
        }
      } else {
        // 首次使用：自动生成并持久化随机密钥（0600）。
        const generated = randomBytes(32).toString('hex');
        mkdirSync(dirname(this.keyFile), { recursive: true });
        writeFileSync(this.keyFile, generated, { mode: 0o600 });
        this.key = this.derive(generated);
        return this.key;
      }
    }
    // 兜底：无任何密钥源（不应发生在配置开启加密时），仅保进程内可用。
    this.key = randomBytes(32);
    return this.key;
  }

  /** 从可读口令派生定长密钥（SHA-256）。
   * @param secret 可读口令（环境变量内容或密钥文件内容）。
   * @returns 32 字节派生密钥。
   */
  private derive(secret: string): Buffer {
    return createHash('sha256').update(secret, 'utf8').digest();
  }

  /**
   * 编码（加密）明文为可落盘字符串（`iv:密文:tag` 的 base64 拼接）。
   * @param text 待加密的明文
   * @returns 密文载荷字符串
   */
  public encode(text: string): string {
    const key = this.resolveKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
  }

  /**
   * 解码（解密）密文载荷回明文；格式损坏时抛错。
   * @param payload 由 `encode` 产生的密文载荷字符串
   * @returns 还原的明文
   */
  public decode(payload: string): string {
    const key = this.resolveKey();
    const [ivB64, cipherB64, tagB64] = payload.split(':');
    if (ivB64 === undefined || cipherB64 === undefined || tagB64 === undefined) {
      throw new Error('记忆密文格式损坏');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(cipherB64, 'base64')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  }
}
