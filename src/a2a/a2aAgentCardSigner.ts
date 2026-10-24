/**
 * A2A 1.0 AgentCard JWS 签名/验签（规范 §8.4）。
 *
 * ## 为什么需要（以及为什么不是自研 JWS）
 *
 * AgentCard 是对外发现面，客户端要能判断「这张卡确实来自声称的提供方、且没被中间人改写」。
 * 规范的做法是 JWS（RFC 7515）：签名覆盖 **RFC 8785 规范化后的卡片正文**（排除 `signatures`
 * 自身），`AgentCardSignature` 只带 `protected`（base64url 的 Protected Header）与 `signature`
 * （分离载荷形态）。手写 Ed25519 验签本身不难，但 JWS 的 base64url / signing-input /
 * 头部解析边界最容易写错，故复用仓内既有的 `jose`（D2 准入项，零新增依赖）。
 *
 * ## 设计约束
 *
 * - **无 key 不伪造签名**：未注入私钥时 `sign()` 直接抛错，`fromEnv()` 返回 undefined；
 *   服务端只会返回**无** `signatures` 的卡，绝不产出「看起来签过」的空签名。
 * - **规范化**：复用 `src/context/canonical.ts` 的稳定序列化（对象 key 字典序、剔除 undefined、
 *   数组保序、无多余空白）。AgentCard 不含浮点数，故这正是 RFC 8785 在本数据形状下的等价形式；
 *   规范要求的「Protobuf 字段存在性」由调用方按需构卡保证（未显式设置的字段不出现）。
 * - **验签 fail-closed**：`verify()` 永不抛错，只返回 `{ ok: false, reason }`；篡改任意字段、
 *   未知 `kid`、过期签名一律拒绝。至少一个签名通过才算通过（支持多渠道签名/轮换）。
 * - **算法白名单**：只接受 Ed25519（`EdDSA`）。不做「按 header.alg 选算法」——那正是
 *   算法混淆攻击的入口。
 *
 * @maturity L1 — 规范化确定性 / 篡改拒绝 / 未知 kid 拒绝 / 过期拒绝 判据钉死
 * @maturityEvidence tests/unit/a2aJws.test.ts
 */
import crypto, { type JsonWebKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compactVerify, CompactSign, type CompactJWSHeaderParameters, type JWK } from 'jose';
import { Canonical } from '../context/canonical.ts';
import { log } from '../util/logger.ts';
import type { A2aAgentCard, A2aAgentCardSignature } from './a2aProtocol.ts';

/** 本实现接受的 JWS 算法（白名单；只认 Ed25519）。 */
const ALLOWED_ALGORITHMS: readonly string[] = ['EdDSA'];

/** 缺省 key id（未显式配置时使用；显式配置可支持轮换）。 */
const DEFAULT_KID = 'omni-a2a-card';

/** 验签时的缺省时钟偏移容忍（秒）：签名端与本端时钟轻微漂移不应误拒。 */
const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

/** JWS Protected Header 的最小形状（其余头部参数原样保留但不参与信任判定）。 */
interface A2aJwsProtectedHeader {
  /** 签名算法（只接受 EdDSA）。 */
  readonly alg?: unknown;
  /** key id（必须在 keyResolver 中可解析）。 */
  readonly kid?: unknown;
  /** JWKS 地址（可选；由 keyResolver 决定是否使用）。 */
  readonly jku?: unknown;
  /** 过期时间（epoch 秒；可选，本仓扩展）。 */
  readonly exp?: unknown;
  /** 其余头部参数。 */
  readonly [key: string]: unknown;
}

/** 可注入的签名私钥形态。 */
export interface A2aAgentCardSigningKey {
  /** key id（写进 Protected Header；轮换时用于区分多把钥匙）。 */
  readonly kid?: string;
  /** Ed25519 私钥 JWK（`kty: 'OKP'`, `crv: 'Ed25519'`, 含 `d`）。 */
  readonly privateKeyJwk?: JWK;
  /** 或者 PKCS#8 PEM 私钥（Ed25519）。 */
  readonly privateKeyPem?: string;
  /** JWKS 地址（写进 Protected Header 的 `jku`；不含私钥，可公开）。 */
  readonly jku?: string;
  /** 签名过期时间（epoch 毫秒；缺省不过期）。 */
  readonly expiresAt?: number;
}

/** 验签时用于解析公钥的回调（按 `kid` / `jku` 查可信密钥）。 */
export type A2aAgentCardKeyResolver = (
  kid: string,
  jku: string | undefined,
) => JWK | KeyObject | undefined | Promise<JWK | KeyObject | undefined>;

/** 签名器构造选项。 */
export interface A2aAgentCardSignerOptions {
  /** 私钥材料（必填；缺失即抛错——绝不在无 key 时产出签名）。 */
  readonly key: A2aAgentCardSigningKey;
  /** 缺省时钟偏移容忍（秒；仅影响 `verify`）。 */
  readonly clockToleranceSec?: number;
  /** 注入时钟（测试用；缺省 `Date.now`）。 */
  readonly now?: () => number;
}

/** 验签结论（永不抛错）。 */
export interface A2aAgentCardVerification {
  /** 是否至少有一个签名通过。 */
  readonly ok: boolean;
  /** 通过验签的签名所用 `kid`（ok 时给出）。 */
  readonly kid?: string;
  /** 拒绝原因（ok=false 时给出；用于审计，不回显密钥材料）。 */
  readonly reason?: string;
}

/**
 * AgentCard JWS 签名器/校验器（Ed25519）。
 *
 * 同一实例既能签名也能验签（验签仍需外部 `keyResolver` 提供**公钥**——私钥不参与验签判定）。
 */
export class A2aAgentCardSigner {
  /** 已解析的 Ed25519 私钥（构造期即校验，坏 key 立刻暴露而不是等到第一次签名）。 */
  private readonly privateKey: KeyObject;
  /** 公钥 JWK（仅用于自检/导出；私钥 `d` 绝不外泄）。 */
  private readonly publicKeyJwk: JWK;
  /** key id。 */
  private readonly kid: string;
  /** 可选 JWKS 地址（写入 Protected Header 的 `jku`）。 */
  private readonly jku: string | undefined;
  /** 签名过期时间（epoch 毫秒；undefined 表示不过期）。 */
  private readonly expiresAt: number | undefined;
  /** 注入时钟。 */
  private readonly now: () => number;
  /** 验签时钟偏移容忍（秒）。 */
  private readonly clockToleranceSec: number;

  /**
   * @param options 私钥材料与时钟容忍。
   */
  public constructor(options: A2aAgentCardSignerOptions) {
    this.privateKey = A2aAgentCardSigner.resolvePrivateKey(options.key);
    this.publicKeyJwk = crypto.createPublicKey(this.privateKey).export({ format: 'jwk' }) as JWK;
    this.kid =
      options.key.kid !== undefined && options.key.kid.trim() !== ''
        ? options.key.kid.trim()
        : DEFAULT_KID;
    this.jku = options.key.jku;
    this.expiresAt = options.key.expiresAt;
    this.now = options.now ?? Date.now;
    this.clockToleranceSec = Math.max(0, options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC);
  }

  /**
   * 从环境变量构造签名器（组合根用；未配置私钥时返回 undefined，**不伪造签名**）。
   *
   * 识别以下变量：
   * - `OMNI_A2A_CARD_KEY_JWK`：Ed25519 私钥 JWK 的 JSON 原文；
   * - `OMNI_A2A_CARD_KEY_FILE`：含 JWK JSON 或 PKCS#8 PEM 的文件路径；
   * - `OMNI_A2A_CARD_KID` / `OMNI_A2A_CARD_JKU`：key id 与 JWKS 地址（可选）；
   * - `OMNI_A2A_CARD_TTL_SEC`：签名有效期（秒；可选）。
   *
   * 「显式 key 即启用」；`OMNI_A2A_SIGN_CARD=1` 只表达「想签」，无 key 时仍返回 undefined。
   * @param env 环境变量表（缺省 `process.env`，便于测试注入）。
   * @returns 已配置好的签名器；无 key、材料非法或读取失败时为 undefined。
   */
  public static fromEnv(env: NodeJS.ProcessEnv = process.env): A2aAgentCardSigner | undefined {
    const material = A2aAgentCardSigner.keyMaterialFromEnv(env);
    if (material === undefined) return undefined;
    try {
      const ttlSec = A2aAgentCardSigner.positiveIntOf(env['OMNI_A2A_CARD_TTL_SEC']);
      const kid = env['OMNI_A2A_CARD_KID']?.trim();
      const jku = env['OMNI_A2A_CARD_JKU']?.trim();
      return new A2aAgentCardSigner({
        key: {
          ...(kid !== undefined && kid !== '' ? { kid } : {}),
          ...material,
          ...(jku !== undefined && jku !== '' ? { jku } : {}),
          ...(ttlSec !== undefined ? { expiresAt: Date.now() + ttlSec * 1000 } : {}),
        },
      });
    } catch (error) {
      log.warn('a2a.card.sign.invalidKey', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 是否**要求**签名（仅读开关；真正的启用条件是配置了私钥）。
   * @param env 环境变量表（缺省 `process.env`）。
   * @returns `OMNI_A2A_SIGN_CARD` 为真时为 true。
   */
  public static signingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env['OMNI_A2A_SIGN_CARD'] ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  }

  /**
   * 给 AgentCard 追加一条 JWS 签名（覆盖已有的 `signatures`：本实例是唯一签名者）。
   *
   * 签名输入 = `ASCII(protected ‖ "." ‖ BASE64URL(UTF8(RFC8785(card \ signatures))))`；
   * `AgentCardSignature` 只回传 `protected` 与 `signature`（正文不重复携带）。
   * @param card 待签名卡片（不会被就地修改）。
   * @returns 带 `signatures` 的新卡片。
   */
  public async sign(card: A2aAgentCard): Promise<A2aAgentCard> {
    const payload = A2aAgentCardSigner.canonicalPayload(card);
    const header = this.protectedHeader();
    const jws = await new CompactSign(new TextEncoder().encode(payload))
      .setProtectedHeader(header)
      .sign(this.privateKey);
    const parts = jws.split('.');
    if (parts.length !== 3) {
      throw new Error('jose 产出的 JWS 不是 compact 三部件形态');
    }
    const signature: A2aAgentCardSignature = {
      protected: A2aAgentCardSigner.requirePart(parts, 0),
      signature: A2aAgentCardSigner.requirePart(parts, 2),
    };
    return { ...card, signatures: [signature] };
  }

  /**
   * 校验 AgentCard 的签名（至少一个通过即 ok；永不抛错）。
   *
   * 拒绝面：`signatures` 缺失/空、Protected Header 非法、算法不在白名单、`kid` 缺失或解析不到、
   * 签名过期（`exp` 已过）、签名值不匹配、载荷被篡改（重算的规范化正文与 JWS 载荷不一致）。
   * @param card 收到的卡片。
   * @param resolveKey 按 `kid` / `jku` 解析**公钥**的回调。
   * @returns 验签结论。
   */
  public async verify(
    card: A2aAgentCard,
    resolveKey: A2aAgentCardKeyResolver,
  ): Promise<A2aAgentCardVerification> {
    const signatures = card.signatures;
    if (signatures === undefined || signatures.length === 0) {
      return { ok: false, reason: '卡片没有 signatures（未签名不得视为已认证）' };
    }
    const expectedPayload = A2aAgentCardSigner.canonicalPayload(card);
    const reasons: string[] = [];
    for (const signature of signatures) {
      const verdict = await this.verifyOne(signature, expectedPayload, resolveKey);
      if (verdict.ok) return verdict;
      if (verdict.reason !== undefined) reasons.push(verdict.reason);
    }
    return { ok: false, reason: reasons.join('; ') || '没有可用的签名' };
  }

  /**
   * 取本实例的公钥 JWK（供发布 JWKS；**不含**私钥分量 `d`）。
   * @returns 公钥 JWK 的副本。
   */
  public publicJwk(): JWK {
    return {
      ...this.publicKeyJwk,
      kid: this.kid,
      ...(this.jku !== undefined ? { jku: this.jku } : {}),
    };
  }

  /**
   * 校验单条签名。
   * @param signature 签名条目。
   * @param expectedPayload 由收到的卡片重算的规范化正文。
   * @param resolveKey 公钥解析回调。
   * @returns 验签结论。
   */
  private async verifyOne(
    signature: A2aAgentCardSignature,
    expectedPayload: string,
    resolveKey: A2aAgentCardKeyResolver,
  ): Promise<A2aAgentCardVerification> {
    try {
      const header = A2aAgentCardSigner.parseProtectedHeader(signature.protected);
      if (header === undefined) return { ok: false, reason: 'Protected Header 非法' };
      if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(header.alg)) {
        return { ok: false, reason: `不接受的签名算法: ${String(header.alg)}` };
      }
      if (typeof header.kid !== 'string' || header.kid.trim() === '') {
        return { ok: false, reason: 'Protected Header 缺少 kid' };
      }
      const expired = this.expiryReason(header);
      if (expired !== undefined) return { ok: false, reason: expired };
      const kid = header.kid;
      const jku = typeof header.jku === 'string' ? header.jku : undefined;
      const key = await resolveKey(kid, jku);
      if (key === undefined) return { ok: false, reason: `未知 kid: ${kid}` };
      const payloadB64 = Buffer.from(expectedPayload, 'utf8').toString('base64url');
      const jws = `${signature.protected}.${payloadB64}.${signature.signature}`;
      const verified = await compactVerify(jws, key, {
        algorithms: [...ALLOWED_ALGORITHMS],
      });
      const actual = new TextDecoder().decode(verified.payload);
      if (actual !== expectedPayload) {
        return { ok: false, reason: `载荷与规范化正文不一致（kid=${kid}）` };
      }
      return { ok: true, kid };
    } catch (error) {
      return {
        ok: false,
        reason: `验签失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 判断签名是否过期（`exp` 是 epoch 秒；非数字即视为非法而非放行）。
   * @param header 已解析的 Protected Header。
   * @returns 拒因；未过期或未声明 exp 时为 undefined。
   */
  private expiryReason(header: A2aJwsProtectedHeader): string | undefined {
    if (header.exp === undefined) return undefined;
    if (typeof header.exp !== 'number' || !Number.isFinite(header.exp)) {
      return 'Protected Header 的 exp 非法';
    }
    const nowSec = this.now() / 1000;
    if (nowSec > header.exp + this.clockToleranceSec) {
      return `签名已过期（exp=${String(header.exp)}）`;
    }
    return undefined;
  }

  /**
   * 构造 JWS Protected Header（`alg` / `typ` / `kid` 必带，`jku` / `exp` 按配置）。
   * @returns 头部对象。
   */
  private protectedHeader(): CompactJWSHeaderParameters {
    return {
      alg: 'EdDSA',
      typ: 'JOSE',
      kid: this.kid,
      ...(this.jku !== undefined ? { jku: this.jku } : {}),
      ...(this.expiresAt !== undefined ? { exp: Math.floor(this.expiresAt / 1000) } : {}),
    };
  }

  /**
   * 规范化待签正文：剔除 `signatures` 后做稳定序列化（RFC 8785 等价形态）。
   * @param card AgentCard。
   * @returns 规范化 JSON 文本。
   */
  private static canonicalPayload(card: A2aAgentCard): string {
    const unsigned: Record<string, unknown> = { ...card };
    delete unsigned['signatures'];
    return Canonical.stableStringify(unsigned);
  }

  /**
   * 解析 Protected Header（base64url JSON）。
   * @param protectedValue Protected Header 字段。
   * @returns 头部对象；格式非法时为 undefined。
   */
  private static parseProtectedHeader(protectedValue: string): A2aJwsProtectedHeader | undefined {
    try {
      const decoded = JSON.parse(
        Buffer.from(protectedValue, 'base64url').toString('utf8'),
      ) as unknown;
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        return undefined;
      }
      return decoded as A2aJwsProtectedHeader;
    } catch {
      return undefined;
    }
  }

  /**
   * 解析并校验私钥材料（Ed25519 only）。
   * @param key 注入的私钥材料。
   * @returns Node 私钥对象。
   */
  private static resolvePrivateKey(key: A2aAgentCardSigningKey): KeyObject {
    const material =
      key.privateKeyJwk !== undefined
        ? crypto.createPrivateKey({
            key: key.privateKeyJwk as unknown as JsonWebKey,
            format: 'jwk',
          })
        : key.privateKeyPem !== undefined
          ? crypto.createPrivateKey({ key: key.privateKeyPem, format: 'pem' })
          : undefined;
    if (material === undefined) {
      throw new Error('A2aAgentCardSigner 需要 Ed25519 私钥（privateKeyJwk 或 privateKeyPem）');
    }
    if (material.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `A2aAgentCardSigner 只接受 Ed25519 私钥，收到: ${String(material.asymmetricKeyType)}`,
      );
    }
    return material;
  }

  /**
   * 从环境变量读出私钥材料（不含 kid/jku/有效期）。
   * @param env 环境变量表。
   * @returns 私钥材料；未配置时为 undefined。
   */
  private static keyMaterialFromEnv(
    env: NodeJS.ProcessEnv,
  ): Pick<A2aAgentCardSigningKey, 'privateKeyJwk' | 'privateKeyPem'> | undefined {
    const inline = (env['OMNI_A2A_CARD_KEY_JWK'] ?? '').trim();
    if (inline !== '') {
      try {
        return { privateKeyJwk: JSON.parse(inline) as JWK };
      } catch {
        log.warn('a2a.card.sign.invalidJwkEnv', { env: 'OMNI_A2A_CARD_KEY_JWK' });
        return undefined;
      }
    }
    const file = (env['OMNI_A2A_CARD_KEY_FILE'] ?? '').trim();
    if (file === '') return undefined;
    try {
      const text = readFileSync(file, 'utf8').trim();
      return text.startsWith('{')
        ? { privateKeyJwk: JSON.parse(text) as JWK }
        : { privateKeyPem: text };
    } catch (error) {
      log.warn('a2a.card.sign.keyFileUnreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 读取正整数（非法或缺失均为 undefined）。
   * @param raw 环境变量原文。
   * @returns 正整数；非法时为 undefined。
   */
  private static positiveIntOf(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  /**
   * 取数组下标处的分隔部件（缺失即抛错，避免静默产出半截签名）。
   * @param parts 分隔后的部件。
   * @param index 下标。
   * @returns 部件原文。
   */
  private static requirePart(parts: readonly string[], index: number): string {
    const value = parts[index];
    if (value === undefined || value === '') {
      throw new Error(`JWS 部件缺失（index=${String(index)}）`);
    }
    return value;
  }
}
