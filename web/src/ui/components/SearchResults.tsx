// 会话搜索的远端结果视图：分组（会话 / 工作区文件）+ 命中片段高亮与截断 + ↑/↓ 选中态。
//
// 纯展示组件（函数组件范式）：无状态、无副作用、不发起请求；键盘由输入框（combobox）承接，
// 本组件只负责把「选中项」画出来，保证键盘高亮与 Enter 打开的是同一项（aria-activedescendant 指向它）。

import { React } from '../deps.js';
import { SearchHitGrouper } from '../models/SearchHitGrouper.js';
import type { SearchGroup } from '../models/SearchHitGrouper.js';
import type { SearchHit } from '../../types/models.js';

/** SearchResults 组件的入参。 */
export interface SearchResultsProps {
  /** 分组结果（空数组表示尚无结果）。 */
  groups: readonly SearchGroup[];
  /** 当前选中序号（相对拍平后的列表，-1 表示无）。 */
  selectedIndex: number;
  /** 当前关键字（用于高亮与截断）。 */
  query: string;
  /** 是否正在等待远端响应。 */
  loading: boolean;
  /** 选中某条命中（点击 / Enter 共用）。 */
  onPick: (hit: SearchHit) => void;
}

/** 结果列表容器 id（输入框的 aria-controls 指向它）。 */
export const SEARCH_LIST_ID = 'session-search-results';

/**
 * 把文本切成命中/非命中片段（命中段用 `<mark>` 标出）。
 * @param text 文本
 * @param query 关键字
 * @returns 渲染节点数组
 */
function highlight(text: string, query: string): ReactNode[] {
  return SearchHitGrouper.segments(text, query).map((seg, i) =>
    seg.hit ? (
      <mark key={'h' + String(i)} className="sr-hit">
        {seg.text}
      </mark>
    ) : (
      <span key={'t' + String(i)}>{seg.text}</span>
    ),
  );
}

/**
 * 远端搜索结果视图：无关键字时整块不渲染（把空间还给本地会话列表）。
 * @param props 组件入参
 * @returns 结果节点；无关键字时为 null
 */
export function SearchResults(props: SearchResultsProps): ReactElement | null {
  const { groups, selectedIndex, query, loading, onPick } = props;
  if (query.trim() === '') return null;
  const flat = SearchHitGrouper.flat(groups);
  const total = flat.length;
  const status = loading ? '搜索中…' : total === 0 ? '无匹配结果' : `找到 ${total} 条结果`;
  return (
    <div className="search-results">
      <div className="sr-status" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </div>
      <div
        className="sr-options"
        id={SEARCH_LIST_ID}
        role="listbox"
        aria-label="会话与文件搜索结果"
      >
        {groups.map((g) => (
          <div className="sr-group" key={g.kind} role="group" aria-label={g.title}>
            <div className="sr-group-title">
              {g.title}
              <span className="sr-count">{g.items.length}</span>
            </div>
            {g.items.map((hit) => {
              const i = flat.findIndex((h) => h.kind === hit.kind && h.id === hit.id);
              const active = i === selectedIndex;
              return (
                <div
                  key={hit.kind + ':' + hit.id}
                  id={'sr-opt-' + String(i)}
                  className={'sr-item' + (active ? ' active' : '')}
                  role="option"
                  aria-selected={active ? 'true' : 'false'}
                  title={hit.id}
                  onMouseDown={(e: MouseEvent) => {
                    e.preventDefault();
                    onPick(hit);
                  }}
                >
                  <span className="sr-label">{highlight(hit.label, query)}</span>
                  <span className="sr-hint">
                    {highlight(SearchHitGrouper.snippet(hit.hint, query, 40), query)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
