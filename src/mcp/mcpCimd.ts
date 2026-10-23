/**
 * CIMD（Client ID Metadata Document，OAuth Client ID Metadata Document）解析（2026-10-22）。
 *
 * CIMD：`client_id` 本身是 HTTPS URL，授权服务器拉取该文档获取 redirect_uris 等元数据。
 * 本类只做客户端侧**预检**：URL 必须 https（localhost 开发例外）、文档 `client_id` 必须与 URL
 * 逐字一致、redirect_uri 必须在 `redirect_uris` 内；不做动态注册。
 */
export interface McpClientMetadata {
  /** 客户端标识（URL）。 */
  readonly clientId: string;
  /** 允许的回调地址。 */
  readonly redirectUris: readonly string[];
  /** 客户端名（可选）。 */
  readonly clientName?: string | undefined;
  /** 令牌端点认证方式（可选）。 */
  readonly tokenEndpointAuthMethod?: string | undefined;
}

/**
 * CIMD 解析器。
 */
export class McpCimd {
  /**
   * 拉取并校验 client metadata document。
   * @param clientId client_id（必须是 https URL；localhost http 允许开发）。
   * @param fetchImpl fetch 注入。
   * @returns 元数据。
   * @throws URL 非法/非 https/文档不匹配时抛错（fail-closed）。
   */
  public static async resolve(
    clientId: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<McpClientMetadata> {
    const url = McpCimd.parse(clientId);
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`CIMD 拉取失败: HTTP ${String(response.status)}`);
    }
    const raw = (await response.json()) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('CIMD 文档必须是 JSON 对象');
    }
    const record = raw as Record<string, unknown>;
    if (record['client_id'] !== clientId) {
      throw new Error('CIMD 文档 client_id 与 URL 不一致');
    }
    const redirects = record['redirect_uris'];
    if (
      !Array.isArray(redirects) ||
      redirects.length === 0 ||
      redirects.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error('CIMD 文档缺少 redirect_uris');
    }
    return {
      clientId,
      redirectUris: redirects as readonly string[],
      ...(typeof record['client_name'] === 'string' ? { clientName: record['client_name'] } : {}),
      ...(typeof record['token_endpoint_auth_method'] === 'string'
        ? { tokenEndpointAuthMethod: record['token_endpoint_auth_method'] }
        : {}),
    };
  }

  /**
   * 校验 client_id 形态。
   * @param clientId client_id。
   * @returns 是否为 CIMD URL。
   */
  public static isCimd(clientId: string): boolean {
    try {
      McpCimd.parse(clientId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析并限制 scheme。
   * @param clientId client_id URL。
   * @returns 解析后的 URL。
   */
  private static parse(clientId: string): URL {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new Error(`client_id 不是合法 URL: ${clientId}`);
    }
    const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
      throw new Error('CIMD client_id 必须是 HTTPS URL（localhost 开发例外）');
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error('CIMD client_id 不得含 userinfo');
    }
    if (url.pathname === '/' || url.pathname === '') {
      throw new Error('CIMD client_id 必须含路径');
    }
    if (/(^|\/)\.\.?(\/|$)/u.test(clientId)) {
      throw new Error('CIMD client_id 不得含 dot-segment');
    }
    if (url.hash !== '') throw new Error('CIMD client_id 不得含 fragment');
    return url;
  }
}
