/**
 * 技能包签名/验签（2026-10-22，P1-5 第二片）。
 *
 * 签名对象是**声明式技能子集**的规范化 JSON（name/description/instructions/tags，按 name 排序）；
 * 使用 Ed25519（Node 内置 crypto）。分发方用私钥签名；使用方在 `--skills` 加载时用
 * `OMNI_SKILL_TRUSTED_KEY` 指向的可信公钥验签，未配置可信公钥的签名包一律拒绝。
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { SkillEntry } from './skill.ts';

/** 已签名技能包。 */
export interface SignedSkillManifest {
  /** 版本固定 1。 */
  readonly version: 1;
  /** 技能清单。 */
  readonly skills: readonly SkillEntry[];
  /** 分发方公钥（PEM）。 */
  readonly publicKey: string;
  /** Ed25519 签名（base64）。 */
  readonly signature: string;
}

/**
 * 技能包签名器（纯函数 + 注入密钥）。
 */
export class SkillManifestSigner {
  /**
   * 规范化负载（确定性：技能按 name 排序、只保留声明式字段）。
   * @param skills 技能清单。
   * @returns 规范化 JSON 字符串。
   */
  public static canonical(skills: readonly SkillEntry[]): string {
    const normalized = [...skills]
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        ...(skill.tags !== undefined ? { tags: [...skill.tags].sort() } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({ version: 1, skills: normalized });
  }

  /**
   * 签名技能包。
   * @param skills 技能清单。
   * @param privateKeyPem Ed25519 私钥（PKCS8 PEM）。
   * @returns 签名包。
   */
  public static sign(skills: readonly SkillEntry[], privateKeyPem: string): SignedSkillManifest {
    const payload = Buffer.from(SkillManifestSigner.canonical(skills), 'utf8');
    const signature = sign(null, payload, createPrivateKey(privateKeyPem));
    return {
      version: 1,
      skills,
      publicKey: createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
      signature: signature.toString('base64'),
    };
  }

  /**
   * 验签。
   * @param manifest 签名包。
   * @param trustedPublicKeyPem 可信公钥（PEM）；缺省则用包内公钥（只保证完整性，不保证来源）。
   * @returns 验签通过为 true。
   */
  public static verify(manifest: SignedSkillManifest, trustedPublicKeyPem?: string): boolean {
    if (
      trustedPublicKeyPem !== undefined &&
      trustedPublicKeyPem.trim() !== manifest.publicKey.trim()
    ) {
      return false;
    }
    try {
      const payload = Buffer.from(SkillManifestSigner.canonical(manifest.skills), 'utf8');
      return verify(
        null,
        payload,
        createPublicKey(manifest.publicKey),
        Buffer.from(manifest.signature, 'base64'),
      );
    } catch {
      return false;
    }
  }

  /**
   * 判断 JSON 是否为签名包形状。
   * @param raw 解析后的 JSON。
   * @returns 是签名包时为 true。
   */
  public static isSigned(raw: unknown): raw is SignedSkillManifest {
    return (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as Record<string, unknown>)['version'] === 1 &&
      typeof (raw as Record<string, unknown>)['signature'] === 'string' &&
      typeof (raw as Record<string, unknown>)['publicKey'] === 'string' &&
      Array.isArray((raw as Record<string, unknown>)['skills'])
    );
  }
}
