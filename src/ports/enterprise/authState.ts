/**
 * @beta
 * `auth login` 持久化的中间态（state + verifier + 配置），供 `auth callback` 续跑。
 *
 * 已从 `enterprise/oidcClient.ts` 外迁到 ports/enterprise：原文件退化为纯再导出桶，调用点零改动。
 */
export interface AuthState {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly redirectUri?: string | undefined;
  readonly scope?: string | undefined;
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: string;
}
