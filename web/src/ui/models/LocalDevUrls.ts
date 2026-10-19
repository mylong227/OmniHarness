// 会话里出现过的**本地开发地址**收集器（纯静态、零 React，node 可直测）。
//
// 右栏网页预览的空态里列这些地址，解决「Agent 起了 dev server，我只看到一行日志、
// 还得手抄 localhost:5173」的问题：`npm run dev` 的输出、助手的「已启动 http://localhost:5173」
// 都会命中最新的几条，一键进预览。
//
// 只收**回环** http(s) 地址：公网链接进 iframe 大概率被 `X-Frame-Options` 拒绝，
// 列出来只会制造"点了没反应"的假入口。

import { PreviewUrl } from './PreviewUrl.ts';

/** 收集选项。 */
export interface LocalDevUrlsOptions {
  /** 最多保留几条（缺省 6）。 */
  readonly limit?: number;
  /** 需要排除的 `host:port`（通常是 UI 自己的地址，避免把工作台本身列成预览目标）。 */
  readonly excludeHostPort?: string;
}

/** 候选地址的正则（http(s) 绝对地址；末尾标点单独裁掉）。 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gu;

/** 末尾常见标点（中文与英文），从匹配结果里裁掉。 */
const TRAILING = /[.,;:!?，。；：！？、）】》]+$/u;

/** 本地开发地址收集器。 */
export class LocalDevUrls {
  /**
   * 从若干段文本里收集回环 http(s) 地址（去重、保序、按需截断）。
   * @param texts 文本片段（事件正文、工具输出等；非字符串项忽略）
   * @param options 上限与排除项
   * @returns 地址列表（最近的在前由调用方决定；本方法保持输入顺序）
   */
  public static collect(
    texts: readonly (string | undefined)[],
    options: LocalDevUrlsOptions = {},
  ): string[] {
    const limit = options.limit ?? 6;
    const exclude = (options.excludeHostPort ?? '').trim().toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const text of texts) {
      if (typeof text !== 'string' || text === '') continue;
      for (const match of text.matchAll(URL_RE)) {
        const raw = match[0].replace(TRAILING, '');
        const url = PreviewUrl.absolute(raw);
        if (url === null || !PreviewUrl.isLoopbackUrl(url)) continue;
        let hostPort = '';
        try {
          hostPort = new URL(url).host.toLowerCase();
        } catch {
          continue;
        }
        if (exclude !== '' && hostPort === exclude) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
