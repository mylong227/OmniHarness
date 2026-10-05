/**
 * 自研 OIDC 流程族的**同端口适配**（Wave A.5 · 第四项）。
 *
 * ## 定位（与 `LegacyIdTokenVerifier` 同纪律）
 *
 * `openid-client` 准入后生产默认走第三方实现（`adapters/enterprise/openIdClientFlow.ts`）；
 * 本类把既有自研资产 `OidcClient`（discovery/PKCE/授权 URL/换码，行为逐字节不变）适配成
 * {@link OidcFlowPort}，与第三方实现做**同端口差分对照**，并作为回退路径——
 * 回退 = 换一个实现实例，调用点零改动。资产保留但不闲置：差分判据持续在 CI 里跑。
 *
 * ## 差分已知面（判据逐条记录于 tests/unit/oidcFlowContract.test.ts）
 *
 * - discovery 文档 issuer 与请求 issuer 不一致：本实现**如实透传**（不裁决），
 *   第三方实现**拒绝**——生产切第三方后此校验收紧；
 * - discovery 不强制 https（fetch 什么拉什么），第三方实现默认拒绝 http。
 */
import type {
  OidcDiscovery,
  OidcFlowPort,
  PkcePair,
  TokenSet,
} from '../ports/enterprise/oidcFlow.js';
import type { OidcProviderConfig } from '../ports/enterprise/oidcProviderConfig.js';
import { OidcClient } from './oidcClient.js';

/**
 * 自研 OIDC 流程族的端口适配器：方法一一委托既有 `OidcClient` 实例，零行为变更。
 */
export class LegacyOidcFlow implements OidcFlowPort {
  /** 被适配的自研流程族（无隐式状态，可并发复用）。 */
  private readonly client: OidcClient;

  /**
   * @param client 被适配的自研实现；缺省新建（与 `OidcClient` 门面同构，测试可注入替身）。
   */
  public constructor(client: OidcClient = new OidcClient()) {
    this.client = client;
  }

  /**
   * 拉取并校验 discovery 文档（委托 `OidcClient.fetchDiscovery`，issuer 取自 config）。
   * @param config OIDC 提供方配置。
   * @param fetchImpl 注入的 fetch 实现（缺省 globalThis.fetch）。
   * @returns 已校验的 discovery 子集。
   */
  public async discovery(
    config: OidcProviderConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<OidcDiscovery> {
    return this.client.fetchDiscovery(config.issuer, fetchImpl);
  }

  /**
   * 生成 PKCE(S256) 密钥对（委托 `OidcClient.generatePkcePair`，包成 Promise 以满足端口形状）。
   * @returns verifier / challenge / method=S256。
   */
  public async generatePkcePair(): Promise<PkcePair> {
    return this.client.generatePkcePair();
  }

  /**
   * 构造授权 URL（委托 `OidcClient.buildAuthorizationUrl`）。
   * @param discovery 已拉取的 discovery 文档。
   * @param config OIDC 提供方配置。
   * @param params state / codeChallenge / scope。
   * @returns 完整的授权端点 URL。
   */
  public authorizationUrl(
    discovery: OidcDiscovery,
    config: OidcProviderConfig,
    params: { readonly state: string; readonly codeChallenge: string; readonly scope?: string },
  ): string {
    return this.client.buildAuthorizationUrl(discovery, config, params);
  }

  /**
   * 授权码换取令牌集（委托 `OidcClient.exchangeCode`；state 由 CLI 层校验，本实现不消费）。
   * @param discovery 已拉取的 discovery 文档。
   * @param config OIDC 提供方配置。
   * @param params code / codeVerifier / redirectUri / fetchImpl（state 忽略，见类注释差分面）。
   * @returns 令牌集；失败抛错。
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
    return this.client.exchangeCode(discovery, config, {
      code: params.code,
      codeVerifier: params.codeVerifier,
      redirectUri: params.redirectUri,
      fetchImpl: params.fetchImpl,
    });
  }
}
