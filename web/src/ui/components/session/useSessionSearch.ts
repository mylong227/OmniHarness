// 会话搜索：本地即时过滤（`query` 交给 SessionViews.filterSessions）＋ 远端 `search.all`。
//
// 从 SessionPanel 抽出（2026-11 长函数拆分）：搜索框的开合、输入、combobox 键盘语义与
// 状态机镜像都在这里；`SessionSearch` 本身仍是零 React 的状态机（防抖 / 乱序丢弃见其头注释），
// 本 hook 只做两件事——把权威快照搬进 state 供渲染、把输入转发进去。

import * as React from 'react';
import { SessionSearch } from '../../models/SessionSearch.ts';
import type { ScheduleFn } from '../../models/SessionSearch.ts';
import type { SearchGroup } from '../../models/SearchHitGrouper.ts';
import type { SearchHit } from '../../../types/models.ts';
import type { ApiClient } from '../../../core/ApiClient.ts';

/** 搜索状态机 + 渲染镜像（跨渲染复用同一个 SessionSearch 实例）。 */
interface SearchMirror {
  /** 状态机实例（move / selected 由交互层直接调用）。 */
  readonly machine: SessionSearch;
  /** 关键字原文（本地过滤与输入框回填都用它）。 */
  readonly query: string;
  /** 远端分组结果（空数组表示尚无结果）。 */
  readonly groups: readonly SearchGroup[];
  /** 远端搜索是否在途。 */
  readonly searching: boolean;
  /** 远端结果的选中序号（↑/↓ 与 Enter 共用）。 */
  readonly hitIndex: number;
  /** 更新关键字：同时更新渲染镜像与状态机。 */
  readonly setQuery: (value: string) => void;
}

/**
 * 搜索状态机 + 渲染镜像。
 *
 * 为什么在渲染期懒建而不是 `useState`：`SessionSearch` 是零 React 对象，`onUpdate` 闭包引用
 * 的是 ref 里的实例（自引用），必须在同一处创建；`useState` 的惰性初始化拿不到该引用。
 * @param api ApiClient（`searchAll` 的宿主）
 * @param scheduleSearch 防抖调度注入点（单测传立即执行版）
 * @returns 状态机与渲染镜像
 */
function useSearchMirror(api: ApiClient, scheduleSearch?: ScheduleFn): SearchMirror {
  const [query, setQueryState] = React.useState<string>('');
  const [groups, setGroups] = React.useState<readonly SearchGroup[]>([]);
  const [searching, setSearching] = React.useState<boolean>(false);
  const [hitIndex, setHitIndex] = React.useState<number>(-1);
  const searchRef = React.useRef<SessionSearch | null>(null);
  if (searchRef.current === null) {
    searchRef.current = new SessionSearch({
      search: (q: string) => api.searchAll(q),
      onUpdate: () => {
        const s = searchRef.current;
        if (s === null) return;
        setGroups(s.groupList());
        setSearching(s.isLoading());
        setHitIndex(s.selectedIndex());
      },
      ...(scheduleSearch !== undefined ? { schedule: scheduleSearch } : {}),
    });
  }
  const machine = searchRef.current;
  // 卸载即丢弃在途防抖（否则定时器会在组件消失后打一次远端搜索）。
  React.useEffect(() => () => machine.dispose(), [machine]);
  const setQuery = (value: string): void => {
    setQueryState(value);
    machine.setQuery(value);
  };
  return { machine, query, groups, searching, hitIndex, setQuery };
}

/** useSessionSearch 的依赖。 */
export interface SessionSearchDeps {
  /** ApiClient（`search.all` 的宿主）。 */
  readonly api: ApiClient;
  /** 打开一条会话命中。 */
  readonly onSelect: (id: string) => void;
  /** 打开一条文件命中（右栏预览）。 */
  readonly onOpenFile: (path: string) => void;
  /** 唤出搜索框时把左栏从图标条拉回（原实现直接 `setRail(false)`）。 */
  readonly onExpand: () => void;
  /** 远端搜索防抖调度注入点（单测传「立即执行」以获得确定性）。 */
  readonly scheduleSearch?: ScheduleFn | undefined;
}

/** 搜索相关的渲染态与交互。 */
export interface SessionSearchApi {
  /** 关键字原文。 */
  readonly query: string;
  /** 远端分组结果。 */
  readonly groups: readonly SearchGroup[];
  /** 远端搜索是否在途。 */
  readonly searching: boolean;
  /** 选中序号（combobox 的 aria-activedescendant 用它）。 */
  readonly hitIndex: number;
  /** 搜索框是否唤出（截图式侧栏不常驻）。 */
  readonly open: boolean;
  /** 结果是否展开（关键字 trim 后非空）。 */
  readonly listOpen: boolean;
  /** 搜索输入框（收成图标条时点放大镜展开并聚焦它）。 */
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  /** 唤出 / 收起搜索框。 */
  readonly toggle: () => void;
  /** 输入变更。 */
  readonly onInput: (e: React.SyntheticEvent) => void;
  /** ↑/↓ / Enter / Esc 键盘语义。 */
  readonly onKeyDown: (e: React.KeyboardEvent) => void;
  /** 打开一条远端命中。 */
  readonly openHit: (hit: SearchHit) => void;
}

/**
 * 会话搜索的完整交互面：状态机镜像 + 搜索框开合 + combobox 键盘。
 * @param deps ApiClient、跳转回调、调度注入点
 * @returns 搜索相关的渲染态与交互
 */
export function useSessionSearch(deps: SessionSearchDeps): SessionSearchApi {
  const mirror = useSearchMirror(deps.api, deps.scheduleSearch);
  const [open, setOpen] = React.useState<boolean>(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  /** 打开一条远端命中：会话跳转 / 文件在右侧面板预览，并清空搜索回到上下文。 */
  const openHit = (hit: SearchHit): void => {
    if (hit.kind === 'chat') deps.onSelect(hit.id);
    else deps.onOpenFile(hit.id);
    mirror.setQuery('');
  };

  /** 搜索框输入：更新本地过滤关键字并把（防抖后的）远端搜索交给状态机。 */
  const onInput = (e: React.SyntheticEvent): void => {
    mirror.setQuery((e.target as HTMLInputElement).value);
  };

  /** 搜索框键盘：↑/↓ 移动选中、Enter 打开、Esc 清空。 */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mirror.machine.move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      mirror.setQuery('');
      return;
    }
    if (e.key === 'Enter') {
      const hit = mirror.machine.selected();
      if (hit !== null) {
        e.preventDefault();
        openHit(hit);
      }
    }
  };

  /** 唤出 / 收起搜索框：收起时清掉本地关键字与在途远端搜索，展开时聚焦输入框。 */
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (!next) {
      mirror.setQuery('');
      return;
    }
    deps.onExpand();
    // 宿主无 rAF（node 测试桩）时跳过聚焦即可，不能让「唤出搜索框」本身抛错。
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return {
    query: mirror.query,
    groups: mirror.groups,
    searching: mirror.searching,
    hitIndex: mirror.hitIndex,
    open,
    listOpen: mirror.query.trim() !== '',
    inputRef,
    toggle,
    onInput,
    onKeyDown,
    openHit,
  };
}
