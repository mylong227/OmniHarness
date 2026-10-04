/**
 * Ed25519 公钥工具（`ssh-ed25519 <base64>` → `KeyObject`，并用它验签）。
 *
 * ## 为什么需要它（而不是各写一份）
 *
 * 仓内既有身份适配器只提供**自己的**公钥编码与"用自己私钥验签"的路径，没有「拿**别人的**公钥验签」
 * 这条路。而至少两处需要它：分发层（验发布者签名，ADR-0011）与 License 引擎（验授权方签名，F1）。
 * 两处各写一份必然漂移（Wave D 那版是本文件的来源，抽出后由两处共用）。
 *
 * ## 格式（RFC 4253 + RFC 8410）
 *
 * `ssh-ed25519` 的公钥 blob = `4 字节大端长度 + "ssh-ed25519"` + `4 字节大端长度 + 32 字节原始密钥`；
 * 把 32 字节原始密钥套上 SPKI（`302a300506032b6570032100`）即可交给 `node:crypto`。
 *
 * @maturity L1 — 格式非法/公钥错误/签名错误三类失败与「用别人公钥验签」正路径判据钉死
 * @maturityEvidence tests/unit/ed25519PublicKey.test.ts
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** Ed25519 SPKI der 前缀（RFC 8410：SEQUENCE + AlgorithmIdentifier + BIT STRING 头）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 公钥原始字节长度（Ed25519 = 32）。 */
const ED25519_KEY_BYTES = 32;

/** SSH 公钥算法名（本仓只支持这一种）。 */
const SSH_ALGORITHM = 'ssh-ed25519';

/** Ed25519 公钥解码与验签（纯静态、无状态）。 */
export class Ed25519PublicKey {
  private constructor() {}

  /**
   * 解出公钥（`ssh-ed25519 <base64>` → KeyObject）。
   * @param publicKeySsh SSH 格式公钥（`ssh-ed25519 AAAA…`，可带注释）
   * @returns 公钥；格式非法时返回**可读原因**（字符串，调用方据此回 reason）
   */
  public static decodeSsh(publicKeySsh: string): KeyObject | string {
    const parts = publicKeySsh.trim().split(/\s+/);
    if (parts.length < 2 || parts[0] !== SSH_ALGORITHM) {
      return `不支持的公钥格式："${publicKeySsh.slice(0, 24)}…"（只支持 ssh-ed25519）`;
    }
    let blob: Buffer;
    try {
      blob = Buffer.from(parts[1] ?? '', 'base64');
    } catch {
      return '公钥 base64 解码失败';
    }
    if (blob.length < 4) return '公钥 blob 过短';
    const nameLength = blob.readUInt32BE(0);
    const keyOffset = 4 + nameLength + 4;
    if (nameLength !== SSH_ALGORITHM.length || keyOffset + ED25519_KEY_BYTES > blob.length) {
      return '公钥 blob 结构非法（长度字段不符）';
    }
    const raw = blob.subarray(keyOffset, keyOffset + ED25519_KEY_BYTES);
    try {
      return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
        format: 'der',
        type: 'spki',
      });
    } catch (err) {
      return `公钥不可用：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 用**指定公钥**验签（Ed25519）。
   *
   * fail-closed：公钥非法、签名非 base64、验签抛错一律 `false`——**绝不**把"验不了"当成"通过"。
   * @param payload 被签名的正文
   * @param signatureB64 签名（base64）
   * @param publicKeySsh 签名者公钥（SSH 格式）
   * @returns 验签是否通过
   */
  public static verify(
    payload: string | Buffer,
    signatureB64: string,
    publicKeySsh: string,
  ): boolean {
    const key = Ed25519PublicKey.decodeSsh(publicKeySsh);
    if (typeof key === 'string') return false;
    try {
      const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
      return cryptoVerify(null, body, key, Buffer.from(signatureB64, 'base64'));
    } catch {
      return false;
    }
  }
}
