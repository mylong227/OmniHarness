// 搜索框（从 SessionPanel 抽出）：combobox 语义 + 结果列表的 aria 关联。
//
// 屏幕阅读器只认输入框上的这套属性：角色 / 自动补全 / 展开态 / 结果列表 id / 当前项 id。
// 结果列表由 SearchResults 渲染（同一个 SEARCH_LIST_ID），两者必须指向同一份选中序号。

import * as React from 'react';
import { SEARCH_LIST_ID } from './SearchResults.tsx';
import { t } from '../i18n/i18n.ts';

/** SessionSearchBox 组件的入参。 */
export interface SessionSearchBoxProps {
  /** 输入框引用（收成图标条时点放大镜展开并聚焦它）。 */
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  /** 关键字原文（受控值）。 */
  readonly query: string;
  /** 结果是否展开（关键字 trim 后非空）。 */
  readonly listOpen: boolean;
  /** 当前选中序号（-1 表示无）。 */
  readonly hitIndex: number;
  /** 输入变更。 */
  readonly onInput: (e: React.SyntheticEvent) => void;
  /** ↑/↓ / Enter / Esc 键盘语义。 */
  readonly onKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * 搜索框（combobox）。
 * @param props 组件入参
 * @returns 搜索框节点
 */
export function SessionSearchBox(props: SessionSearchBoxProps): ReactElement {
  const { inputRef, query, listOpen, hitIndex } = props;
  return (
    <div className="session-toolbar">
      <input
        className="session-search"
        ref={inputRef}
        placeholder={t('搜索会话…')}
        value={query}
        spellCheck={false}
        role="combobox"
        aria-label={t('搜索会话与文件')}
        aria-autocomplete="list"
        aria-expanded={listOpen ? 'true' : 'false'}
        aria-controls={SEARCH_LIST_ID}
        aria-activedescendant={hitIndex >= 0 ? 'sr-opt-' + String(hitIndex) : undefined}
        onChange={props.onInput}
        onKeyDown={props.onKeyDown}
      />
    </div>
  );
}
