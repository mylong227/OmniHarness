/**
 * @beta
 * OIDC 提供方配置。
 *
 * 已从 `enterprise/oidcClient.ts` 外迁到 ports/enterprise：原文件退化为纯再导出桶，调用点零改动。
 */
export interface OidcProviderConfig {
  /** Issuer（如 https://accounts.example.com），将拼接 /.well-known/openid-configuration。 */
  readonly issuer: string;
  /** 在 IdP 注册的应用 client_id。 */
  readonly clientId: string;
  /**  confidential client 的 client_secret（public client 可省略）。 */
  readonly clientSecret?: string | undefined;
  /** 回调地址（需与 IdP 注册一致）。 */
  readonly redirectUri?: string | undefined;
  /** 申请的 scope，默认 `openid profile email`。 */
  readonly scope?: string | undefined;
}
