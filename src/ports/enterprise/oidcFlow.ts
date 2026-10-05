/**
 * OIDC 授权码流端口（Wave A.5 · 第四项依赖准入 `openid-client`）。
 *
 * ## 为什么是端口
 *
 * 自研流程族（`enterprise/oidcClient.ts`）与第三方实现（`adapters/enterprise/openIdClientFlow.ts`，
 * 基于 `openid-client`）以**同一端口**共存，可做逐条差分对照（与 A.5 第三项 `jose` 准入同型）：
 * 生产默认走第三方（依赖政策 D10：同等能力优先成熟依赖），自研降格为回退资产——
 * 回退 = 换一个实现实例，调用点零改动。
 *
 * ## 端口边界（只含协议管道）
 *
 * discovery / PKCE / 授权 URL / 换码四件事；**不含** id_token 签名校验（已有
 * `IdTokenVerifierPort` + `jose` 承接）、**不含** CLI 中间态持久化（应用语义，留在自研资产）。
 */
import type { OidcDiscovery } from './oidcDiscovery.js';
import type { OidcProviderConfig } from './oidcProviderConfig.js';

export type { OidcDiscovery, OidcProviderConfig };

/**
 * @beta
 * PKCE(S256) 密钥对（RFC 7636）：verifier 为高熵随机串，challenge = BASE64URL(SHA256(verifier))。
 */
export interface PkcePair {
  /** code_verifier（43–128 字符的 base64url 高熵随机串）。 */
  readonly verifier: string;
  /** code_challenge = BASE64URL(SHA256(verifier))。 */
  readonly challenge: string;
  /** 变换方法，恒为 `S256`（拒绝 plain 降级）。 */
  readonly method: 'S256';
}

/**
 * @beta
 * 授权码换得的令牌集（字段与 RFC 6749 §5.1 响应同名）。
 */
export interface TokenSet {
  /** 访问令牌（必需；缺失即协议错误，实现必须抛错）。 */
  readonly access_token: string;
  /** OIDC 的 id_token（可选）。 */
  readonly id_token?: string | undefined;
  /** 令牌类型（缺省实现可按 `Bearer` 归一）。 */
  readonly token_type: string;
  /** 访问令牌有效期（秒，可选）。 */
  readonly expires_in?: number | undefined;
  /** 刷新令牌（可选）。 */
  readonly refresh_token?: string | undefined;
  /** IdP 实际授予的 scope（可选）。 */
  readonly scope?: string | undefined;
}

/** discovery / 授权 URL / 换码共用的请求参数（发现由 config 携带 issuer）。 */

/**
 * @beta
 * OIDC 授权码流端口：discovery / PKCE / 授权 URL / 换码。
 *
 * 实现契约：
 * - discovery 必须对「文档 issuer ≠ 请求 issuer」做出裁决（拒绝或如实透传，并在差分判据中记录）；
 * - 换码失败（HTTP 非 2xx / 缺 access_token）必须抛错，绝不静默返回残缺令牌集；
 * - PKCE 恒为 S256。
 */
export interface OidcFlowPort {
  /**
   * 拉取并校验 discovery 文档。
   * @param config OIDC 提供方配置（issuer 定位文档；clientId/clientSecret 供第三方实现的客户端装配）。
   * @param fetchImpl 注入的 fetch 实现（缺省 globalThis.fetch；测试可替换）。
   * @returns 已校验的 discovery 子集。
   */
  discovery(config: OidcProviderConfig, fetchImpl?: typeof fetch): Promise<OidcDiscovery>;
  /**
   * 生成 PKCE(S256) 密钥对。
   * @returns verifier / challenge / method=S256。
   */
  generatePkcePair(): Promise<PkcePair>;
  /**
   * 构造授权码流授权 URL（含 state + PKCE；nonce 由实现生成并附上）。
   * @param discovery 已拉取的 discovery 文档（取 authorization_endpoint）。
   * @param config OIDC 提供方配置（client_id / redirect_uri / scope）。
   * @param params state 防 CSRF、codeChallenge 为 PKCE 挑战、scope 可覆盖配置。
   * @returns 完整的授权端点 URL。
   */
  authorizationUrl(
    discovery: OidcDiscovery,
    config: OidcProviderConfig,
    params: { readonly state: string; readonly codeChallenge: string; readonly scope?: string },
  ): string;
  /**
   * 用授权码换取令牌集。
   * @param discovery 已拉取的 discovery 文档（取 token_endpoint）。
   * @param config OIDC 提供方配置（client_id / client_secret / redirect_uri）。
   * @param params code 必需；codeVerifier（PKCE）/ redirectUri / state / fetchImpl 可选。
   * @returns 令牌集；失败抛错。
   */
  exchangeCode(
    discovery: OidcDiscovery,
    config: OidcProviderConfig,
    params: {
      readonly code: string;
      readonly codeVerifier?: string | undefined;
      readonly redirectUri?: string | undefined;
      /** 防 CSRF 的 state；提供时第三方实现会与回调参数做一致性校验。 */
      readonly state?: string | undefined;
      readonly fetchImpl?: typeof fetch;
    },
  ): Promise<TokenSet>;
}
