// 搜索结果整理：把 `search.all` 的 { files, chats } 变成「分组 + 确定性排序 + 命中高亮/截断」的展示模型。
// 零 React 依赖，可在 node 下直测。
//
// 为什么排序要自己做（服务端已排过一次）：服务端按 BFS 遍历顺序返回文件命中，
// 同一个查询在不同时刻可能给出不同顺序（目录项顺序、并发写入都会影响），
// 而 UI 列表顺序抖动会让「↑↓ 选中 + Enter 打开」变成一场赌博——同输入必须恒同序。

import type { SearchHit } from '../../types/models.js';

/** 一组搜索结果。 */
export interface SearchGroup {
  /** 组类型（决定点击后的去向：会话跳转 / 文件预览）。 */
  readonly kind: 'chat' | 'file';
  /** 组标题。 */
  readonly title: string;
  /** 组内命中（已确定性排序）。 */
  readonly items: readonly SearchHit[];
}

/** 高亮分段：命中段与普通段交替。 */
export interface SnippetSegment {
  /** 文本片段。 */
  readonly text: string;
  /** 是否为命中段。 */
  readonly hit: boolean;
}

/** 搜索结果整理器（纯静态，无状态）。 */
export class SearchHitGrouper {
  /** 每组展示上限（与后端 MAX_HITS 一致，超出部分不展示）。 */
  public static readonly LIMIT = 20;

  /**
   * 确定性排序：命中位置靠前者优先 → 标签短者优先 → id 字典序。
   * @param hits 命中列表（顺序任意）
   * @param query 查询词（大小写不敏感；空串时退化为「短标签优先」）
   * @returns 新数组（不改动入参，同输入恒同序）
   */
  public static sort(hits: readonly SearchHit[], query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    const posOf = (h: SearchHit): number => {
      if (q === '') return -1;
      return h.label.toLowerCase().indexOf(q);
    };
    return hits.slice().sort((a, b) => {
      const pa = posOf(a);
      const pb = posOf(b);
      // 命中位置：-1（仅 hint/id 命中）排在所有真实命中之后。
      const ra = pa < 0 ? Number.MAX_SAFE_INTEGER : pa;
      const rb = pb < 0 ? Number.MAX_SAFE_INTEGER : pb;
      if (ra !== rb) return ra - rb;
      if (a.label.length !== b.label.length) return a.label.length - b.label.length;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    });
  }

  /**
   * 分组：会话在前、文件在后（会话命中通常是「我要找的那次对话」），空组不产出。
   * @param files 文件命中
   * @param chats 会话命中
   * @param query 查询词
   * @returns 分组列表（可能为空数组）
   */
  public static group(
    files: readonly SearchHit[],
    chats: readonly SearchHit[],
    query: string,
  ): SearchGroup[] {
    const out: SearchGroup[] = [];
    const chatsSorted = SearchHitGrouper.sort(chats, query).slice(0, SearchHitGrouper.LIMIT);
    const filesSorted = SearchHitGrouper.sort(files, query).slice(0, SearchHitGrouper.LIMIT);
    if (chatsSorted.length > 0) out.push({ kind: 'chat', title: '会话', items: chatsSorted });
    if (filesSorted.length > 0) out.push({ kind: 'file', title: '工作区文件', items: filesSorted });
    return out;
  }

  /**
   * 拍平成展示顺序的线性列表（↑/↓ 与 Enter 的索引都基于它）。
   * @param groups 分组列表
   * @returns 拍平后的命中列表
   */
  public static flat(groups: readonly SearchGroup[]): SearchHit[] {
    const out: SearchHit[] = [];
    for (const g of groups) for (const h of g.items) out.push(h);
    return out;
  }

  /**
   * 截断到命中片段（命中词居中，两侧各留一半窗口）。
   * @param text 原文
   * @param query 查询词
   * @param max 最大字符数（默认 64）
   * @returns 截断后的文本（含省略号；无命中时取头部）
   */
  public static snippet(text: string, query: string, max = 64): string {
    if (text.length <= max) return text;
    const q = query.trim();
    const at = q === '' ? -1 : text.toLowerCase().indexOf(q.toLowerCase());
    if (at < 0) return text.slice(0, max - 1) + '…';
    const half = Math.floor((max - q.length) / 2);
    const start = Math.max(0, Math.min(at - half, at));
    const end = Math.min(text.length, Math.max(start + max, at + q.length));
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }

  /**
   * 切分命中/非命中片段（供渲染 `<mark>`）。
   * @param text 原文
   * @param query 查询词（大小写不敏感；空串时整段非命中）
   * @returns 分段数组（至少一段）
   */
  public static segments(text: string, query: string): SnippetSegment[] {
    const q = query.trim().toLowerCase();
    if (q === '') return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const out: SnippetSegment[] = [];
    let cursor = 0;
    for (;;) {
      const at = lower.indexOf(q, cursor);
      if (at < 0) break;
      if (at > cursor) out.push({ text: text.slice(cursor, at), hit: false });
      out.push({ text: text.slice(at, at + q.length), hit: true });
      cursor = at + q.length;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
    return out.length > 0 ? out : [{ text, hit: false }];
  }

  /**
   * 移动选中序号（越界夹取）。
   * @param current 当前序号（-1 表示未选中）
   * @param delta 位移（+1 下一项 / -1 上一项）
   * @param count 条目总数
   * @returns 移动后的序号；总数为 0 时为 -1
   */
  public static move(current: number, delta: number, count: number): number {
    if (count <= 0) return -1;
    const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
    return Math.max(0, Math.min(count - 1, base + delta));
  }
}
