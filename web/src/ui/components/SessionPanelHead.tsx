// 左栏顶部区块（从 SessionPanel 抽出）：品牌头 + 一等导航 + 项目切换器 + 任务列表区块头 +
// 搜索框 + 远端结果。
//
// 为什么这六块合成一个组件而不是六个独立组件挂在面板里：它们读的是**同一组** hook 产物
// （外壳开合态 / 工作区 / 搜索），逐个透传会往 SessionPanel 的组件体里灌 25+ 行回调接线，
// 正好是这轮拆分要消灭的东西。这里只收三个「视图模型」对象 + 三个标量。
//
// `panel` 有意只声明本区块读到的字段（结构化子集）：完整 `SessionPanelProps` 天然满足它，
// 因此 SessionPanel 可以直接把 props 传进来，而本文件不需要 import 回面板文件（无循环依赖）。

import { SearchResults } from './SearchResults.tsx';
import { SidebarHeader } from './SidebarHeader.tsx';
import { SessionProjectSwitcher } from './SessionProjectSwitcher.tsx';
import { SessionSearchBox } from './SessionSearchBox.tsx';
import { SessionSectionHead } from './SessionSectionHead.tsx';
import { SessionSideNav } from './SessionSideNav.tsx';
import type { SidebarChrome } from './session/sidebarChrome.ts';
import type { SessionSearchApi } from './session/useSessionSearch.ts';
import type { SessionWorkspaceApi } from './session/useSessionWorkspace.ts';
import type { PanelView } from './session/viewCycle.ts';
import type { SessionEntry } from '../shared.ts';

/** 本区块实际读到的面板 props 子集（结构化类型，不必引用完整 SessionPanelProps）。 */
export interface SessionPanelHeadPanel {
  readonly sessions: SessionEntry[];
  readonly activePane?: string | undefined;
  readonly onNew: () => void;
  readonly onOpenPane?: ((key: string) => void) | undefined;
  readonly scopeAll?: boolean | undefined;
  readonly onToggleScope?: (() => void) | undefined;
}

/** SessionPanelHead 组件的入参。 */
export interface SessionPanelHeadProps {
  /** 面板 props（只读上面那 6 个字段）。 */
  readonly panel: SessionPanelHeadPanel;
  /** 外壳开合态。 */
  readonly chrome: SidebarChrome;
  /** 工作区状态与动作。 */
  readonly workspace: SessionWorkspaceApi;
  /** 搜索状态与交互。 */
  readonly search: SessionSearchApi;
  /** 当前项目名（已压成 basename）。 */
  readonly wsName: string;
  /** 当前列表视图。 */
  readonly view: PanelView;
  /** 切到下一个视图。 */
  readonly onCycleView: () => void;
}

/**
 * 左栏顶部区块。
 * @param props 组件入参
 * @returns 区块节点（六个兄弟节点的片段，不额外包 DOM）
 */
export function SessionPanelHead(props: SessionPanelHeadProps): ReactElement {
  const { panel, chrome, workspace, search, wsName, view, onCycleView } = props;
  return (
    <>
      {/* 品牌头：Ω + 本实现 + 命令面板 + 收起（原 TopBar 的品牌行职责收编于此）。 */}
      <SidebarHeader rail={chrome.rail} />
      <SessionSideNav rail={chrome.rail} activePane={panel.activePane} onNew={panel.onNew} onOpenPane={panel.onOpenPane} />
      <SessionProjectSwitcher
        rail={chrome.rail}
        wsPath={workspace.wsPath}
        wsName={wsName}
        menuOpen={chrome.wsMenuOpen}
        projects={workspace.projects}
        sessions={panel.sessions}
        onToggleMenu={chrome.toggleWsMenu}
        onCloseMenu={chrome.closeWsMenu}
        onSwitch={(p) => void workspace.switchProject(p)}
        onNewInProject={(p) => void workspace.newThreadInProject(p)}
        onReveal={workspace.revealProject}
        onAdd={workspace.addProject}
      />
      <SessionSectionHead
        rail={chrome.rail}
        searchOpen={search.open}
        scopeAll={panel.scopeAll}
        onToggleSearch={search.toggle}
        onToggleScope={panel.onToggleScope}
        view={view}
        onCycleView={onCycleView}
        onAddProject={workspace.addProject}
      />
      {search.open && !chrome.rail ? (
        <SessionSearchBox
          inputRef={search.inputRef}
          query={search.query}
          listOpen={search.listOpen}
          hitIndex={search.hitIndex}
          onInput={search.onInput}
          onKeyDown={search.onKeyDown}
        />
      ) : null}
      <SearchResults
        groups={search.groups}
        selectedIndex={search.hitIndex}
        query={search.query}
        loading={search.searching}
        onPick={search.openHit}
      />
    </>
  );
}
