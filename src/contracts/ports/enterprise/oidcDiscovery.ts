/**
 * @beta
 * OIDC discovery 文档的已校验子集。
 *
 * 已从 `enterprise/oidcClient.ts` 外迁到 ports/enterprise：原文件退化为纯再导出桶，调用点零改动。
 */
export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri?: string | undefined;
  readonly userinfo_endpoint?: string | undefined;
}
