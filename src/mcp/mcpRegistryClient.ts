/**
 * MCP Registry 客户端（2026-10-22，P0-3）。
 *
 * 只做**只读发现**：按关键词查官方 registry，把远端 URL / 包标识解析成可读条目。
 * 安装/启动仍走用户显式 `mcp list --server`；不在本类自动 spawn 远端包。
 */
export interface McpRegistryEntry {
  /** 服务器全名（如 `io.github.owner/server`）。 */
  readonly name: string;
  /** 描述。 */
  readonly description: string;
  /** 版本。 */
  readonly version: string;
  /** 远端 Streamable HTTP/SSE URL 列表。 */
  readonly remotes: readonly string[];
  /** 包标识（如 `npm:@scope/pkg`、`oci:...`）。 */
  readonly packages: readonly string[];
}

/** 查询选项。 */
export interface McpRegistrySearchOptions {
  /** registry 基址（缺省官方）。 */
  readonly registryUrl?: string | undefined;
  /** fetch 注入（测试）。 */
  readonly fetchImpl?: typeof fetch | undefined;
  /** 结果上限（缺省 20，最大 100）。 */
  readonly limit?: number | undefined;
}

/** 官方 registry 基址。 */
export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/**
 * MCP Registry 只读客户端。
 */
export class McpRegistryClient {
  /**
   * 按关键词搜索。
   * @param query 关键词（空串 = 浏览）。
   * @param options registry 基址/fetch/上限。
   * @returns 规范化条目。
   */
  public static async search(
    query: string,
    options: McpRegistrySearchOptions = {},
  ): Promise<readonly McpRegistryEntry[]> {
    const base = (options.registryUrl ?? MCP_REGISTRY_URL).replace(/\/$/u, '');
    const url = new URL(`${base}/v0/servers`);
    url.searchParams.set('search', query);
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, options.limit ?? 20))));
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`MCP registry 查询失败: HTTP ${String(response.status)}`);
    }
    const raw = (await response.json()) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('MCP registry 响应必须是对象');
    }
    const servers = (raw as { servers?: unknown }).servers;
    if (!Array.isArray(servers)) return [];
    return servers.map((entry) => McpRegistryClient.normalize(entry));
  }

  /**
   * 规范化一条 registry 记录（兼容 `{server:{...}}` 包装）。
   * @param raw 原始记录。
   * @returns 规范化条目。
   */
  private static normalize(raw: unknown): McpRegistryEntry {
    const wrapper = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const server =
      typeof wrapper['server'] === 'object' && wrapper['server'] !== null
        ? (wrapper['server'] as Record<string, unknown>)
        : wrapper;
    const remotes = Array.isArray(server['remotes'])
      ? server['remotes']
          .map((remote) =>
            typeof remote === 'object' && remote !== null
              ? (remote as Record<string, unknown>)['url']
              : undefined,
          )
          .filter((url): url is string => typeof url === 'string' && url !== '')
      : [];
    const packages = Array.isArray(server['packages'])
      ? server['packages']
          .map((pkg) => {
            if (typeof pkg !== 'object' || pkg === null) return undefined;
            const record = pkg as Record<string, unknown>;
            const identifier = record['identifier'];
            const registryType = record['registryType'];
            return typeof identifier === 'string' && identifier !== ''
              ? `${typeof registryType === 'string' ? registryType : 'pkg'}:${identifier}`
              : undefined;
          })
          .filter((pkg): pkg is string => pkg !== undefined)
      : [];
    return {
      name: typeof server['name'] === 'string' ? server['name'] : 'unknown',
      description: typeof server['description'] === 'string' ? server['description'] : '',
      version: typeof server['version'] === 'string' ? server['version'] : '',
      remotes,
      packages,
    };
  }
}
