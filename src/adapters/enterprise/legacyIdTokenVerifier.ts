/**
 * 既有自研实现的**端口适配器**（Wave A.5 · 回退资产）。
 *
 * ## 为什么需要它（不是多余的包装）
 *
 * A.5 的判据要求「**自研实现保留回退**，端口两侧并存，迁移与回退 0 个调用点改动」。
 * 既有 `OidcClient` 的接口形状与端口不同（`verifyJwtSignature(token, jwks)` 需要调用方自己取 JWKS，
 * `verifyIdTokenClaims(payload, opts)` 只看声明），因此需要一个**薄适配器**把两者对齐到同一端口：
 *
 * - 这样才能**同端口差分对照**：同一份令牌，两个实现各自给结论——判据据此把「能力增益」写成可核验的数字，
 *   而不是文档里的一句「更安全」；
 * - 回退路径也因此是「换一行装配」而不是「改调用点」。
 *
 * ## 诚实标注：本适配器**继承**自研实现的能力边界
 *
 * 只支持 `RS256`；无时钟偏移容忍；`aud` 为数组时不校验 `azp`（`OidcClient` 的实现所限）。
 * 这些**不是**本适配器的 bug，而是它作为回退资产的真实上限——差分判据会把它们逐条钉出来。
 *
 * @maturity L1 — 与 jose 实现对同一输入的差分结论（含三类已知边界）判据钉死
 * @maturityEvidence tests/unit/joseIdTokenVerifier.test.ts
 */
import { OidcClient } from '../../enterprise/oidcClient.js';
import type {
  IdTokenVerification,
  IdTokenVerificationRequest,
  IdTokenVerifierPort,
} from '../../ports/enterprise/idTokenVerifier.js';

/** 自研实现只接受这一种算法（差分判据据此断言窄面）。 */
const LEGACY_ALGORITHMS: readonly string[] = ['RS256'];

/**
 * 自研实现的 JWKS 入参形状——**从被适配方法的签名反推**（`Parameters<…>[1]`），
 * 而不是手抄一份：抄一份会在 `OidcClient` 改签名时静默漂移。
 */
type LegacyJwks = Parameters<OidcClient['verifyJwtSignature']>[1];

/** 把既有自研实现暴露为 `IdTokenVerifierPort`（回退用）。 */
export class LegacyIdTokenVerifier implements IdTokenVerifierPort {
  /** 自研门面（构造注入，便于判据替换为受控实例）。 */
  private readonly client: OidcClient;
  /** JWKS 获取超时（毫秒）。 */
  private readonly timeoutMs: number;

  /**
   * @param opts 可选项：注入门面实例与超时
   */
  public constructor(opts: { readonly client?: OidcClient; readonly timeoutMs?: number } = {}) {
    this.client = opts.client ?? new OidcClient();
    this.timeoutMs = Math.max(1, opts.timeoutMs ?? 5_000);
  }

  /**
   * 校验 id_token（先取 JWKS，再自研验签 + 声明检查）。
   * @param request 校验请求
   * @returns 校验结论
   */
  public async verify(request: IdTokenVerificationRequest): Promise<IdTokenVerification> {
    if (request.token.trim() === '') return { ok: false, reason: 'id_token 为空' };
    try {
      const decoded = this.client.decodeJwt(request.token);
      const jwks = await this.fetchJwks(request.jwksUrl);
      this.client.verifyJwtSignature(request.token, jwks);
      this.client.verifyIdTokenClaims(decoded.payload, {
        issuer: request.issuer,
        clientId: request.audience,
        ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
      });
      return {
        ok: true,
        claims: decoded.payload,
        algorithm: typeof decoded.header['alg'] === 'string' ? decoded.header['alg'] : 'unknown',
      };
    } catch (err) {
      return {
        ok: false,
        reason: `id_token 校验被拒：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 自研实现接受的算法（只有 RS256——差分判据据此断言窄面）。
   * @returns 算法名列表
   */
  public allowedAlgorithms(): readonly string[] {
    return [...LEGACY_ALGORITHMS];
  }

  /**
   * 取 JWKS（带超时；超时即拒，避免认证路径悬挂）。
   * @param jwksUrl JWKS 端点
   * @returns JWKS
   * @throws 非 2xx / 超时 / JSON 非法时抛错
   */
  private async fetchJwks(jwksUrl: string): Promise<LegacyJwks> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(jwksUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`JWKS 获取失败：HTTP ${String(res.status)}`);
      return (await res.json()) as LegacyJwks;
    } finally {
      clearTimeout(timer);
    }
  }
}
