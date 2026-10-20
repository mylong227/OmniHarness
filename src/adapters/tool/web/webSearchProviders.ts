import type { WebSearchProvider, WebSearchResult } from '../../../ports/tool/webSearchProvider.ts';
import { WebSearchTool } from './webSearchTool.ts';

/** 搜索请求超时（毫秒）。 */
const SEARCH_TIMEOUT_MS = 15_000;

/** 最多返回条数。 */
const MAX_RESULTS = 8;

/**
 * 内置搜索 provider 工厂（ACT-02，2026-10-20）。
 *
 * 只读取环境变量里的 key，不读项目配置文件——搜索 key 属凭据，按仓内纪律只放用户级
 * 环境/用户配置。无 key 时返回 undefined（`configToolRegistry` 因此**不注册** `web_search`，
 * 避免模型反复调用一个必然失败的工具）。
 */
export class WebSearchProviders {
  /**
   * 按环境变量构造 provider。
   * @param env 环境变量（测试可注入）。
   * @param fetchImpl fetch 实现（测试可注入，默认全局 fetch）。
   * @returns 搜索工具；无 key 时为 undefined。
   */
  public static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: typeof fetch = fetch,
  ): WebSearchTool | undefined {
    const brave = env['BRAVE_API_KEY'];
    if (brave !== undefined && brave.trim() !== '') {
      return new WebSearchTool({
        provider: new BraveWebSearch(brave.trim(), fetchImpl),
      });
    }
    const tavily = env['TAVILY_API_KEY'];
    if (tavily !== undefined && tavily.trim() !== '') {
      return new WebSearchTool({
        provider: new TavilyWebSearch(tavily.trim(), fetchImpl),
      });
    }
    return undefined;
  }
}

/** Brave Search API provider（GET，`X-Subscription-Token`）。 */
class BraveWebSearch implements WebSearchProvider {
  /** provider 名。 */
  public readonly name = 'brave';

  /**
   * @param apiKey Brave API key。
   * @param fetchImpl fetch 实现。
   */
  public constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * 调 Brave Web Search。
   * @param query 查询词。
   * @returns 搜索结果。
   */
  public async search(query: string): Promise<readonly WebSearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(MAX_RESULTS));
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Brave 搜索失败：HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as {
      web?: { results?: readonly { title?: string; url?: string; description?: string }[] };
    };
    return (body.web?.results ?? []).slice(0, MAX_RESULTS).map((item) => ({
      title: item.title ?? '(无标题)',
      url: item.url ?? '',
      ...(item.description !== undefined ? { snippet: item.description } : {}),
    }));
  }
}

/** Tavily Search API provider（POST JSON）。 */
class TavilyWebSearch implements WebSearchProvider {
  /** provider 名。 */
  public readonly name = 'tavily';

  /**
   * @param apiKey Tavily API key。
   * @param fetchImpl fetch 实现。
   */
  public constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * 调 Tavily Search。
   * @param query 查询词。
   * @returns 搜索结果。
   */
  public async search(query: string): Promise<readonly WebSearchResult[]> {
    const response = await this.fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: MAX_RESULTS,
        search_depth: 'basic',
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Tavily 搜索失败：HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as {
      results?: readonly { title?: string; url?: string; content?: string }[];
    };
    return (body.results ?? []).slice(0, MAX_RESULTS).map((item) => ({
      title: item.title ?? '(无标题)',
      url: item.url ?? '',
      ...(item.content !== undefined ? { snippet: item.content } : {}),
    }));
  }
}
