/**
 * 网络搜索 provider 端口（ACT-02，2026-10-20）。
 *
 * 为什么需要：`WebSearchTool` 原先只接受一个注入函数，仓库里没有任何内置 provider，
 * 于是默认路径上 `web_search` 根本不存在（模型只能抓已知 URL）。把 provider 抽成端口，
 * 适配器（Brave/Tavily）可独立测试，配置层只在有 key 时注册工具。
 */

/** 一条搜索结果（渲染给模型的字段尽量少而稳定）。 */
export interface WebSearchResult {
  /** 标题。 */
  readonly title: string;
  /** 链接。 */
  readonly url: string;
  /** 摘要（可空）。 */
  readonly snippet?: string | undefined;
}

/** 搜索 provider。 */
export interface WebSearchProvider {
  /** provider 名（日志/诊断用）。 */
  readonly name: string;
  /**
   * 执行搜索。
   * @param query 查询词。
   * @returns 结果列表（按 provider 相关性排序）。
   */
  search(query: string): Promise<readonly WebSearchResult[]>;
}
