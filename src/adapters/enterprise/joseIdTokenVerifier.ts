/**
 * `IdTokenVerifierPort` 的 `jose` 实现（Wave A.5 · 依赖准入第二项）。
 *
 * ## 为什么引 `jose` 而不是继续用自研解析（D10「必要且更优」的逐条证据）
 *
 * 自研的 `OidcClient.verifyJwtSignature` + `verifyIdTokenClaims` 只覆盖 `RS256` 与 iss/aud/exp/nonce；
 * 本实现补齐的是**安全关键且自研容易漏**的部分：
 *
 * | 能力             | 自研 | 本实现                                                                 |
 * | ---------------- | ---- | ---------------------------------------------------------------------- |
 * | JWS 算法面       | 仅 RS256 | RS/ES/PS 全族（**显式排除 `none` 与 `HS\*`**——算法混淆攻击的入口） |
 * | 时钟偏移         | 无（精确比较 exp） | `clockTolerance`（缺省 30s，可配）                            |
 * | `azp` 校验       | 无（`aud` 为数组时只 `includes`） | 多受众时强制核对 `azp`                             |
 * | JWKS 缓存与轮换  | 每次自取自管 | `createRemoteJWKSet`：**未知 kid 自动重取**，带缓存与冷却           |
 * | 取值有界         | 无 | 令牌体积上限 + JWKS 获取超时（两者都必须有界，见 §12.1-3）              |
 *
 * `jose` 为 MIT、**零传递依赖**（实测），退出答案：删本文件、切回既有自研实现（同端口，0 个调用点改动）。
 *
 * @maturity L1 — 算法混淆拒绝 / 时钟偏移边界 / azp / 轮换重取 / 取值有界 判据钉死
 * @maturityEvidence tests/unit/joseIdTokenVerifier.test.ts
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type {
  IdTokenVerification,
  IdTokenVerificationRequest,
  IdTokenVerifierPort,
} from '../../ports/enterprise/idTokenVerifier.js';

/**
 * 允许的 JWS 算法（**白名单**，不是黑名单）。
 *
 * 为什么必须显式列举：`none` 是「无签名」、`HS*` 是**算法混淆攻击**的入口
 * （攻击者用 IdP 的公钥当 HMAC 密钥签一个 HS256 token，若实现按 header.alg 选算法就会验签通过）。
 * 白名单同时挡住这两类，且新增算法必须是一次显式评审。
 */
const ALLOWED_ALGORITHMS: readonly string[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
];

/** 令牌体积上限（字节）：超过即拒，避免把无界输入喂给解析器。 */
const MAX_TOKEN_BYTES = 16 * 1024;

/** 缺省时钟偏移容忍（秒）。 */
const DEFAULT_CLOCK_TOLERANCE_SEC = 30;

/** 缺省 JWKS 获取超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** JWKS 缓存冷却（毫秒）：未知 kid 触发的重取不得被高频请求放大。 */
const JWKS_COOLDOWN_MS = 30_000;

/** `jose` 实现的 id_token 校验器。 */
export class JoseIdTokenVerifier implements IdTokenVerifierPort {
  /** 按 URL 缓存的远程 JWKS 取键器（含缓存与轮换重取）。 */
  private readonly jwksSets = new Map<string, JWTVerifyGetKey>();
  /** JWKS 缓存冷却（毫秒）：未知 kid 触发的重取频率上限。 */
  private readonly jwksCooldownMs: number;

  /**
   * @param opts 可选：JWKS 缓存冷却（毫秒；缺省 30s——轮换窗口内避免被高频请求放大）
   */
  public constructor(opts: { readonly jwksCooldownMs?: number | undefined } = {}) {
    this.jwksCooldownMs = Math.max(0, opts.jwksCooldownMs ?? JWKS_COOLDOWN_MS);
  }

  /**
   * 校验 id_token。
   * @param request 校验请求
   * @returns 校验结论
   */
  public async verify(request: IdTokenVerificationRequest): Promise<IdTokenVerification> {
    const sizeCheck = JoseIdTokenVerifier.checkSize(request.token);
    if (sizeCheck !== undefined) return { ok: false, reason: sizeCheck };
    const urlCheck = JoseIdTokenVerifier.checkUrl(request.jwksUrl);
    if (urlCheck !== undefined) return { ok: false, reason: urlCheck };

    const timeoutMs = Math.max(1, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const tolerance = Math.max(0, request.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC);
    try {
      const { payload, protectedHeader } = await jwtVerify(
        request.token,
        this.jwksFor(request.jwksUrl, timeoutMs),
        {
          issuer: request.issuer,
          audience: request.audience,
          algorithms: [...ALLOWED_ALGORITHMS],
          clockTolerance: tolerance,
        },
      );
      const azpReason = JoseIdTokenVerifier.checkAuthorizedParty(payload, request.audience);
      if (azpReason !== undefined) return { ok: false, reason: azpReason };
      const nonceReason = JoseIdTokenVerifier.checkNonce(payload, request.nonce);
      if (nonceReason !== undefined) return { ok: false, reason: nonceReason };
      return {
        ok: true,
        claims: payload as Readonly<Record<string, unknown>>,
        algorithm: protectedHeader.alg,
      };
    } catch (err) {
      return { ok: false, reason: `id_token 校验被拒：${JoseIdTokenVerifier.messageOf(err)}` };
    }
  }

  /**
   * 本实现接受的 JWS 算法（可审计面）。
   * @returns 允许的算法名列表（副本，调用方无法改动内部白名单）
   */
  public allowedAlgorithms(): readonly string[] {
    return [...ALLOWED_ALGORITHMS];
  }

  /**
   * 取（并缓存）某 JWKS 端点的远程取键器。
   * @param jwksUrl JWKS 端点
   * @param timeoutMs 单次获取超时
   * @returns `jose` 取键器
   */
  private jwksFor(jwksUrl: string, timeoutMs: number): JWTVerifyGetKey {
    const hit = this.jwksSets.get(jwksUrl);
    if (hit !== undefined) return hit;
    const set = createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: timeoutMs,
      cooldownDuration: this.jwksCooldownMs,
    });
    this.jwksSets.set(jwksUrl, set);
    return set;
  }

  /**
   * 令牌体积校验（有界输入）。
   * @param token 待校验令牌
   * @returns 拒因；通过时 undefined
   */
  private static checkSize(token: string): string | undefined {
    if (token.trim() === '') return 'id_token 为空';
    if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      return `id_token 超过体积上限（${String(MAX_TOKEN_BYTES)} 字节）`;
    }
    return undefined;
  }

  /**
   * JWKS 端点校验：必须是 **https**（或本地环回，供自托管/测试）——防止把 JWKS 取到明文信道。
   * @param jwksUrl JWKS 端点
   * @returns 拒因；通过时 undefined
   */
  private static checkUrl(jwksUrl: string): string | undefined {
    let url: URL;
    try {
      url = new URL(jwksUrl);
    } catch {
      return `JWKS 端点不是合法 URL`;
    }
    const localhost =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
      return `JWKS 端点必须为 https（本地环回例外）`;
    }
    return undefined;
  }

  /**
   * `nonce` 校验（**必须自己写**：`jose` 的 `jwtVerify` 不认 `nonce` 选项——
   * 传给它会被**静默忽略**，于是「nonce 不匹配的 id_token」会被当成合法令牌接受。
   * 这条是判据当场抓出来的：本实现第一版把 `nonce` 交给 jose，判据立刻红）。
   * @param payload 已验签的声明集
   * @param expected 期望 nonce（未提供则不做该项检查）
   * @returns 拒因；通过时 undefined
   */
  private static checkNonce(
    payload: Readonly<Record<string, unknown>>,
    expected: string | undefined,
  ): string | undefined {
    if (expected === undefined) return undefined;
    if (payload['nonce'] !== expected) {
      return `id_token nonce 不匹配（收到 ${String(payload['nonce'])}）`;
    }
    return undefined;
  }

  /**
   * 多受众令牌的 `azp` 校验（OIDC Core 3.1.3.7：`aud` 为多值时必须核对 `azp`）。
   * @param payload 已验签的声明集
   * @param audience 期望受众
   * @returns 拒因；通过时 undefined
   */
  private static checkAuthorizedParty(
    payload: Readonly<Record<string, unknown>>,
    audience: string,
  ): string | undefined {
    const aud = payload['aud'];
    if (!Array.isArray(aud) || aud.length <= 1) return undefined;
    const azp = payload['azp'];
    if (azp !== audience) {
      return `id_token 多受众缺少匹配的 azp（azp=${String(azp)}）`;
    }
    return undefined;
  }

  /**
   * 取异常的可读信息（**不回显 token**，避免把凭据写进日志）。
   * @param err 异常
   * @returns 原因文本
   */
  private static messageOf(err: unknown): string {
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code;
      return typeof code === 'string' ? `${code}: ${err.message}` : err.message;
    }
    return String(err);
  }
}
