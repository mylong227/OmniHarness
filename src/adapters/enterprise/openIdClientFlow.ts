/**
 * `openid-client`（v6）的 OIDC 流程端口适配（Wave A.5 · 第四项依赖准入）。
 *
 * ## 准入依据（可核验形式，登记于 dependency-allowlist.json）
 *
 - 同等能力优先成熟依赖（D10）：授权码流 + PKCE + discovery/token 交换是**协议管道**，
   `openid-client` 是 OAuth/OIDC 生态的标准实现（自带 issuer 严格校验、PKCE S256、
   state/nonce 检查、client 认证方法族、令牌响应校验），自研版这些都要逐条手搓且只能靠单测兜底；
 - 预算：本包 221 KB + 传递依赖 `oauth4webapi` 326 KB（`jose ^6.2.12` 与既有准入**同版本共享**）
   ⇒ 合计新增 ≈550 KB，低于默认预算 2048 KB / 20 传递依赖（实际 2 个）；
 - 分层：仅落在 `src/adapters/enterprise`（依赖只允许出现在适配层）；生产默认切本实现，
   自研 `LegacyOidcFlow` 同端口保留为回退资产（差分判据持续在 CI）。
 *
 * ## 与自研实现的行为差分（判据记录于 tests/unit/oidcFlowContract.test.ts）
 *
 * - discovery 文档 issuer ≠ 请求 issuer ⇒ **拒绝**（自研版透传）；
 * - discovery 默认拒绝 **http**（测试经 `insecureHttp` 显式降档访问本地 mock IdP；
   自研版无 https 强制）；
 * - token 端点的 client 认证默认同为 `client_secret_post`（confidential）/ 无（public），
   与自研版一致。
 */
import type {
  OidcDiscovery,
  OidcFlowPort,
  PkcePair,
  TokenSet,
} from '../../ports/enterprise/oidcFlow.js';
import type { OidcProviderConfig } from '../../ports/enterprise/oidcProviderConfig.js';
import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery as oidcDiscovery,
  randomNonce,
  randomPKCECodeVerifier,
  ClientSecretPost,
  type Configuration,
  type DiscoveryRequestOptions,
} from 'openid-client';

/** 构造选项。 */
export interface OpenIdClientFlowOptions {
  /**
   * 允许 **http**（非 TLS）的 issuer 与端点。**仅供测试**（本地 mock IdP 监听在
   * `http://127.0.0.1`）；生产实例一律缺省（https 强制，与 openid-client 缺省一致）。
   */
  readonly insecureHttp?: boolean;
}

/**
 * `openid-client` 实现的 OIDC 授权码流端口。
 */
export class OpenIdClientFlow implements OidcFlowPort {
  /** issuer|clientId → 已解析的 Configuration（discovery 一次，后续复用）。 */
  private readonly configurations = new Map<string, Configuration>();
  /** 构造选项（insecureHttp 仅测试用）。 */
  private readonly options: OpenIdClientFlowOptions | undefined;

  /**
   * @param options 构造选项（生产可省略——https 强制）。
   */
  public constructor(options?: OpenIdClientFlowOptions) {
    this.options = options;
  }

  /**
   * 拉取并校验 discovery（openid-client `discovery()`：issuer 严格匹配 + 端点校验，
   * 并装配好 client 认证与后续请求所需的 fetch）。
   * @param config OIDC 提供方配置。
   * @param fetchImpl 注入的 fetch 实现（经 `customFetch` 符号传给 openid-client，并驻留在
   *   Configuration 上供后续 token/JWKS 请求复用）。
   * @returns 已校验的 discovery 子集。
   */
  public async discovery(
    config: OidcProviderConfig,
    fetchImpl?: typeof fetch,
  ): Promise<OidcDiscovery> {
    const clientAuth =
      config.clientSecret === undefined ? undefined : ClientSecretPost(config.clientSecret);
    const options: DiscoveryRequestOptions = {};
    if (this.options?.insecureHttp === true) {
      options.execute = [allowInsecureRequests];
    }
    if (fetchImpl !== undefined) {
      // openid-client 的 customFetch 收到的是自述形状（method/headers/body 的普通对象），
      // 显式转成 fetch 的 RequestInit——字段一一映射，不做断言。
      options[customFetch] = (url, init) => {
        const requestInit: RequestInit = {
          method: init.method,
          headers: init.headers,
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
        };
        return fetchImpl(url, requestInit);
      };
    }
    const configuration = await oidcDiscovery(
      new URL(config.issuer),
      config.clientId,
      undefined,
      clientAuth,
      options,
    );
    const meta = configuration.serverMetadata();
    // fail-closed：两个必需端点缺失/非字符串即抛（与自研实现同一裁决面），不做断言蒙混。
    if (
      typeof meta.authorization_endpoint !== 'string' ||
      typeof meta.token_endpoint !== 'string'
    ) {
      throw new Error('OIDC discovery 缺少必需端点 authorization_endpoint / token_endpoint');
    }
    this.configurations.set(this.keyOf(config), configuration);
    return {
      issuer: meta.issuer ?? config.issuer,
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      jwks_uri: meta.jwks_uri ?? undefined,
      userinfo_endpoint: meta.userinfo_endpoint ?? undefined,
    };
  }

  /**
   * 生成 PKCE(S256) 密钥对（openid-client `randomPKCECodeVerifier` + `calculatePKCECodeChallenge`）。
   * @returns verifier / challenge / method=S256。
   */
  public async generatePkcePair(): Promise<PkcePair> {
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    return { verifier, challenge, method: 'S256' };
  }

  /**
   * 构造授权 URL（openid-client `buildAuthorizationUrl`：response_type=code 自动补齐，
   * nonce 由 `randomNonce()` 生成并附上——与自研实现口径一致）。
   * @param discovery 已拉取的 discovery 文档。
   * @param config OIDC 提供方配置。
   * @param params state / codeChallenge / scope。
   * @returns 完整的授权端点 URL。
   * @throws Error 本实例尚未对该 issuer/clientId 调过 {@link OpenIdClientFlow.discovery}
   *   （AuthorizationUrl 需要 discovery 装配出的 Configuration 上下文；两个生产调用点都是先 discovery 后用）。
   */
  public authorizationUrl(
    discovery: OidcDiscovery,
    config: OidcProviderConfig,
    params: { readonly state: string; readonly codeChallenge: string; readonly scope?: string },
  ): string {
    const configuration = this.requireConfiguration(discovery.issuer, config);
    const url = buildAuthorizationUrl(configuration, {
      ...(config.redirectUri !== undefined ? { redirect_uri: config.redirectUri } : {}),
      scope: params.scope ?? config.scope ?? 'openid profile email',
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      nonce: randomNonce(),
    });
    return url.toString();
  }

  /**
   * 授权码换取令牌集（openid-client `authorizationCodeGrant`：内部完成 client 认证、
   * PKCE 校验、state 一致性检查与令牌响应校验；错误统一转成可读 {@link Error}）。
   * @param discovery 已拉取的 discovery 文档。
   * @param config OIDC 提供方配置。
   * @param params code 必需；codeVerifier / redirectUri / state / fetchImpl 可选。
   * @returns 令牌集；失败抛错（含 IdP 的 error code，如 `invalid_grant`）。
   */
  public async exchangeCode(
    discovery: OidcDiscovery,
    config: OidcProviderConfig,
    params: {
      readonly code: string;
      readonly codeVerifier?: string | undefined;
      readonly redirectUri?: string | undefined;
      readonly state?: string | undefined;
      readonly fetchImpl?: typeof fetch;
    },
  ): Promise<TokenSet> {
    let configuration = this.configurations.get(this.keyOf(config));
    if (configuration === undefined) {
      await this.discovery(config, params.fetchImpl);
      configuration = this.configurations.get(this.keyOf(config));
    }
    if (configuration === undefined) {
      throw new Error('OIDC Configuration 未就绪（discovery 失败或被并发清空）');
    }
    const redirectUri = params.redirectUri ?? config.redirectUri;
    if (redirectUri === undefined) {
      throw new Error('OIDC 换码需要 redirect_uri（config 或 params 至少提供一处）');
    }
    const currentUrl = new URL(redirectUri);
    currentUrl.searchParams.set('code', params.code);
    if (params.state !== undefined) currentUrl.searchParams.set('state', params.state);
    try {
      const tokens = await authorizationCodeGrant(
        configuration,
        currentUrl,
        {
          ...(params.state !== undefined ? { expectedState: params.state } : {}),
          // openid-client 的字段名是 pkceCodeVerifier（不是 codeVerifier）。
          ...(params.codeVerifier !== undefined ? { pkceCodeVerifier: params.codeVerifier } : {}),
        },
        { redirect_uri: redirectUri },
      );
      if (typeof tokens.access_token !== 'string' || tokens.access_token === '') {
        // 端口契约：缺 access_token 属协议错误，必须抛错（与自研实现同一裁决面）。
        throw new Error('OIDC token 响应缺少 access_token');
      }
      // RFC 6749 §4.2.2：token_type 大小写不敏感，规范形为 'Bearer'（openid-client 会归一成小写）。
      const tokenType = typeof tokens.token_type === 'string' ? tokens.token_type : '';
      return {
        access_token: tokens.access_token,
        id_token: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
        token_type: tokenType.toLowerCase() === 'bearer' ? 'Bearer' : tokenType,
        expires_in: typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined,
        refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
        scope: typeof tokens.scope === 'string' ? tokens.scope : undefined,
      };
    } catch (err) {
      throw new Error(`OIDC token 交换失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 取该 issuer/clientId 对应的 Configuration（须先 discovery）。
   * @param issuer IdP issuer 标识。
   * @param config OIDC 提供方配置。
   * @returns 已装配的 Configuration。
   */
  private requireConfiguration(issuer: string, config: OidcProviderConfig): Configuration {
    const configuration = this.configurations.get(`${issuer}|${config.clientId}`);
    if (configuration === undefined) {
      throw new Error('OpenIdClientFlow：须先调用 discovery(config) 再构造授权 URL');
    }
    return configuration;
  }

  /**
   * 缓存键（同一 IdP 上不同 clientId 各自装配）。
   * @param config OIDC 提供方配置。
   * @returns 缓存键字符串。
   */
  private keyOf(config: OidcProviderConfig): string {
    return `${config.issuer}|${config.clientId}`;
  }
}
