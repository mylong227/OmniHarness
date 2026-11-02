// 左栏顶部项目切换器（从 SessionPanel 抽出）：当前项目 + 下拉项目条 + 「+ 添加项目」。
//
// 纯展示（函数组件范式）：项目清单、当前路径与全部动作都由宿主注入；展开态也由宿主持有
// （收成图标条时点它不展开，见下方 `!rail`）。项目条本身仍由 SessionViews.renderProjectsView
// 渲染，与其它入口共用同一套行卡片。

import { icon } from '../models/Icon.ts';
import type { SessionEntry } from '../shared.ts';
import { renderProjectsView } from './SessionViews.tsx';
import { t } from '../i18n/i18n.ts';

/** SessionProjectSwitcher 组件的入参。 */
export interface SessionProjectSwitcherProps {
  /** 左栏是否已收成图标条（收起时只留这一个按钮、不展开菜单）。 */
  readonly rail: boolean;
  /** 当前工作区路径（空串 = 尚未解析）。 */
  readonly wsPath: string;
  /** 当前项目名（已按 `PathJoiner.basename` 压过；空路径时为「未选择项目」）。 */
  readonly wsName: string;
  /** 下拉是否展开。 */
  readonly menuOpen: boolean;
  /** 已添加的项目路径清单。 */
  readonly projects: string[];
  /** 会话清单（项目条上的线程计数用）。 */
  readonly sessions: readonly SessionEntry[];
  /** 翻转下拉。 */
  readonly onToggleMenu: () => void;
  /** 关闭下拉（选中项目 / 添加项目后收起）。 */
  readonly onCloseMenu: () => void;
  /** 切换到某项目。 */
  readonly onSwitch: (path: string) => void;
  /** 在某项目新建线程。 */
  readonly onNewInProject: (path: string) => void;
  /** 在系统文件管理器中打开项目目录。 */
  readonly onReveal: (path: string) => void;
  /** 打开「添加项目」目录选择器。 */
  readonly onAdd: () => void;
}

/**
 * 左栏顶部项目切换器。
 * @param props 组件入参
 * @returns 切换器节点
 */
export function SessionProjectSwitcher(props: SessionProjectSwitcherProps): ReactElement {
  const { rail, wsPath, wsName, menuOpen, projects, sessions } = props;
  return (
    <div className="ws-switch">
      <button
        className="ws-switch-btn"
        title={wsPath || t('选择项目')}
        aria-haspopup="menu"
        aria-expanded={menuOpen ? 'true' : 'false'}
        onClick={props.onToggleMenu}
      >
        <span className="ws-switch-icon">{icon('folder', { size: 14 })}</span>
        {rail ? null : <span className="ws-switch-name">{wsName}</span>}
        {rail ? null : <span className="ws-caret">▾</span>}
      </button>
      {menuOpen && !rail ? (
        <div className="ws-switch-menu" role="menu">
          {renderProjectsView(
            projects,
            wsPath,
            (p) => {
              props.onCloseMenu();
              props.onSwitch(p);
            },
            sessions,
            (p) => props.onNewInProject(p),
            props.onReveal,
          )}
          <button
            className="ws-add"
            onClick={() => {
              props.onCloseMenu();
              props.onAdd();
            }}
          >
            {t('+ 添加项目')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
