// 工作台控制台（设置中心）的**唯一外壳**：左分组导航 + 右页面。
//
// ## 结构来源（2026-10-26 用户给的参考）
//
//   左侧：品牌 / 返回工作区 / 分组导航 / 工作区与连接状态；
//   右侧：工具栏（当前位置 + 关闭）、页面标题与说明、卡片式设置行。
//
// ## 全窗口页面，不是模态（2026-10-26 用户要求）
//
// 用户原话：「点击设置不要弹窗，就是直接覆盖当前的会话区」。参考图里的设置页是**整窗视图**：
// 应用自己的会话栏 / 对话 / 右栏全部让位，只保留控制台自带的左侧导航。因此本组件由 App
// 直接放进 `.body`（`.body.console-open` 隐藏应用左栏），铺满视口；关闭后原样恢复。
// 设置按钮与「全部面板」按钮只是**落点不同**（常规 / 上次面板），共用这一张视图。
// 导航清单来自 `models/ConsoleRegistry.ts`。
//
// ## 几何契约
//
// 工作区尺寸与顶栏高度恒定：内容长短只决定右栏滚不滚；切页时 `.sp-content` 的 scrollTop
// 归零。`web/test/panelModalSize.test.ts` 仍按 `.panel-modal` / `.sp-top` / `.sp-content`
// / `[data-pane]` 量真机矩形（类名沿用历史名，避免探针漂移）。
//
// ## 无障碍
//
// role=region + aria-label；**没有焦点陷阱**（嵌入视图不该把焦点关住）；Esc 关闭；
// 打开时焦点落到当前导航项，关闭时还给触发按钮。导航自 2026-10-29（W2）起是 antd Menu：
// role=menu + roving tabindex（Tab 进菜单、↑↓ 换项），条目上的 `aria-current="page"` 仍逐个自己标
// （不是 tablist——这里每次只挂载一个页面，用 tab 语义会要求 aria-controls 指向不存在的面板）。

import * as React from 'react';
// Menu 走子路径（不走 'antd' 桶文件）：本组件是 lazy 块，barrel 导入会把 menu 族钉死在
// 首屏 vendor（见 vite.config.ts「分块改造」注释）；MenuProps 是纯类型导入，不进产物。
import Menu from 'antd/es/menu';
import type { MenuProps } from 'antd';
import { icon } from '../../models/Icon.ts';
import { useApp } from '../../context.ts';
import { t } from '../../i18n/i18n.ts';
import {
  CONSOLE_ENTRIES,
  CONSOLE_GROUPS,
  consoleEntryOf,
  isSettingKey,
  type ConsoleEntry,
  type ConsoleGroupDef,
} from '../../models/ConsoleRegistry.ts';
import { panelScopeOf } from '../../models/PanelScope.ts';
import { SettingsSurface, type SettingsSurfaceProps } from './SettingsSurface.tsx';
import { BrandMark } from '../BrandMark.tsx';

/** 关闭键。 */
const ESC = 'Escape';

/** 设置页的数据范围标签（面板走 PanelScope）。 */
const SETTING_SCOPE: Readonly<Record<string, 'server' | 'global' | 'session'>> = {
  general: 'global',
  model: 'server',
  runtime: 'server',
  permission: 'server',
  desktop: 'global',
  shortcuts: 'global',
};

/** ConsoleView 的入参。 */
export interface ConsoleViewProps {
  /** 是否打开。 */
  open: boolean;
  /** 当前条目 key（设置分栏或面板 key）。 */
  active: string;
  /** 切换条目。 */
  onPick: (key: string) => void;
  /** 关闭控制台。 */
  onClose: () => void;
  /** 当前面板内容（App 按 activePane 渲染好的节点；仅面板条目使用）。 */
  panelContent?: React.ReactNode;
  /** 设置页上下文（不含当前分栏与跳页回调；分栏取 `active`，跳页走 `onPick`）。 */
  settings: Omit<SettingsSurfaceProps, 'tab' | 'onNavigate'>;
  /** 当前工作区路径（左栏页脚）。 */
  workspacePath: string;
  /** SSE 是否已连接。 */
  connected: boolean;
  /** SSE 三态（决定「重连中 / 断开」文案）。 */
  streamState?: 'open' | 'connecting' | 'closed';
  /**
   * 打开控制台瞬间持有焦点的元素（App 在收起抽屉**之前**捕获）。
   * 本组件是 lazy 块：挂载时触发器可能已被抽屉收起失焦，「关闭归还焦点」必须以打开瞬间为准。
   * 命令面板路径不传——此时退回挂载时的 activeElement（与历史行为一致）。
   */
  consoleOpenerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * 取条目的数据范围徽标文案。
 * @param entry 条目
 * @param hasSession 当前是否选中会话
 * @returns 文案
 */
function scopeTextOf(entry: ConsoleEntry, hasSession: boolean): string {
  if (entry.kind === 'setting') {
    const scope = SETTING_SCOPE[entry.key] ?? 'global';
    return scope === 'server' ? t('服务端配置') : t('本机偏好');
  }
  const scope = panelScopeOf(entry.key).scope;
  if (scope === 'session') return hasSession ? t('本会话') : t('未选择会话');
  if (scope === 'workspace') return t('工作区');
  if (scope === 'server') return t('服务端');
  return t('全局');
}

/**
 * 取条目的数据范围 class（复用 `.scope-chip` 的语义色）。
 * @param entry 条目
 * @returns scope 名
 */
function scopeClassOf(entry: ConsoleEntry): 'session' | 'workspace' | 'global' | 'server' {
  return entry.kind === 'setting'
    ? (SETTING_SCOPE[entry.key] ?? 'global')
    : panelScopeOf(entry.key).scope;
}

/** 一个导航分组及其条目（`CONSOLE_GROUPS` × `CONSOLE_ENTRIES` 的联表结果）。 */
interface ConsoleNavGroup {
  /** 分组声明。 */
  readonly group: ConsoleGroupDef;
  /** 组内条目（顺序即显示顺序）。 */
  readonly entries: readonly ConsoleEntry[];
}

/**
 * 把分组条目映射成 antd Menu 的 `items`（纯函数；放组件外是因为组件体有 80 行铁律）。
 *
 * 四处契约由这里显式写死、不随组件库漂移：
 *   · `data-pane`：真机探针 / 几何判据 / 焦点判据都按它定位条目；
 *   · `sp-nav-item` 类：`.panel-modal .sp-nav-item` 的既有选择器与视觉规则；
 *   · `on` 类：几何判据钉「当前面板」标记（`.panel-modal [data-pane="graph"].on`）；
 *   · `aria-current` 与原生 `title`：antd 只给视觉选中态，这两条它不代劳。
 *
 * @param groups 分组与组内条目
 * @param activeKey 当前条目 key
 * @returns Menu items（分组 + 条目）
 */
function navItemsOf(groups: readonly ConsoleNavGroup[], activeKey: string): MenuProps['items'] {
  return groups.map(({ group, entries }) => ({
    key: `group:${group.key}`,
    type: 'group',
    label: <span className="csl-group-label">{t(group.label)}</span>,
    children: entries.map((item) => {
      const on = item.key === activeKey;
      return {
        key: item.key,
        title: t(item.hint),
        className: 'sp-nav-item csl-nav-item' + (on ? ' on' : ''),
        'data-pane': item.key,
        'aria-current': on ? 'page' : undefined,
        icon: (
          <span className="csl-nav-icon" aria-hidden="true">
            {icon(item.icon, { size: 15 })}
          </span>
        ),
        label: <span className="csl-nav-label">{t(item.label)}</span>,
      };
    }),
  }));
}

/**
 * 控制台外壳。
 * @param props 组件入参
 * @returns 视图节点（未打开时为 null）
 */
export function ConsoleView(props: ConsoleViewProps): ReactElement | null {
  const {
    open,
    active,
    onPick,
    onClose,
    panelContent,
    settings,
    workspacePath,
    connected,
    streamState,
    consoleOpenerRef,
  } = props;
  const { sessionId, sessionTick } = useApp();

  // 条目在 hooks 之前解出：打开焦点要用它的 key，而 effect 必须在 `if (!open)` 早退之前。
  const entry = consoleEntryOf(active);
  // 切页不抢焦点：effect 只在「打开」这一刻复位焦点，故用 ref 读最新的当前项 key。
  const currentKeyRef = React.useRef(entry.key);
  currentKeyRef.current = entry.key;
  const [navOpen, setNavOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // 打开时的焦点落点：当前导航项（键盘用户接着上下走）。
  // antd Menu 的条目是 `<li role="menuitem" tabindex="-1">`，不把 ref 透传到 li ⇒
  // 在导航容器里按 `data-pane` 查（该属性是探针 / 几何 / 焦点判据的公共契约）。
  const navRef = React.useRef<HTMLElement | null>(null);

  // Esc 关闭。挂 window：焦点可能暂时落在框外，容器上的 onKeyDown 收不到。
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === ESC) {
        onClose();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时把焦点放到当前导航项，关闭时还给触发按钮。
  // opener 不能依赖挂载时的 activeElement：本组件是 lazy 块，挂载前浏览器可能已因「收起抽屉」
  // 把触发器失焦（visibility:hidden），故用 App 在按下瞬间记下的 consoleOpenerRef（无 ref 则退回历史行为）。
  React.useEffect(() => {
    if (!open) return undefined;
    const fromRef = consoleOpenerRef?.current ?? null;
    if (consoleOpenerRef !== undefined) consoleOpenerRef.current = null;
    const opener = fromRef ?? (document.activeElement as HTMLElement | null);
    const raf = requestAnimationFrame(() => {
      // 窄屏左栏是抽屉（关闭时 visibility:hidden）：此时不要把焦点送进看不见的导航。
      const narrow =
        typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;
      const current = navRef.current?.querySelector<HTMLElement>(
        `[data-pane="${currentKeyRef.current}"]`,
      );
      const first = narrow && !navOpen ? rootRef.current : (current ?? rootRef.current);
      first?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, [open]);

  // 移动端抽屉打开后把焦点移到当前导航项（否则焦点留在地面工具栏上）。
  React.useEffect(() => {
    if (!open || !navOpen) return;
    navRef.current?.querySelector<HTMLElement>(`[data-pane="${currentKeyRef.current}"]`)?.focus();
  }, [open, navOpen]);

  // 切页 / 重开时内容回到顶部：新页面不该继承上一页的滚动位置。
  React.useLayoutEffect(() => {
    if (!open) return;
    const el = contentRef.current;
    if (el !== null) el.scrollTop = 0;
  }, [open, active]);

  // 关闭时复位移动端抽屉（下次打开是干净状态）。
  React.useEffect(() => {
    if (open) return;
    setNavOpen(false);
  }, [open]);

  if (!open) return null;

  const groups = CONSOLE_GROUPS.map((group) => ({
    group,
    entries: CONSOLE_ENTRIES.filter((item) => item.group === group.key),
  })).filter((item) => item.entries.length > 0);
  const hasSession = sessionId !== null;
  const scope = scopeClassOf(entry);
  const scopeText = scopeTextOf(entry, hasSession);
  const connState = streamState ?? (connected ? 'open' : 'closed');

  // 导航交给 antd Menu（W2）：分组、选中态、↑↓/Home/End 与动效由组件库负责；
  // `data-pane` / `sp-nav-item` / `on` / `aria-current` 四处契约见 `navItemsOf`。
  const navItems = navItemsOf(groups, entry.key);

  /** 选择条目：移动端顺手收起导航抽屉。 */
  const pick = (key: string): void => {
    onPick(key);
    setNavOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={'sp panel-modal csl csl-embedded' + (navOpen ? ' nav-open' : '')}
      role="region"
      aria-label={t('工作台控制台')}
      data-console-view="1"
      tabIndex={-1}
    >
      <aside className="sp-nav csl-rail">
        <div className="csl-brand">
          <BrandMark />
          <span className="csl-brand-text">
            <span className="csl-brand-name">OmniHarness</span>
            <span className="csl-brand-sub">{t('工作台控制台')}</span>
          </span>
          <button
            className="csl-nav-close"
            type="button"
            aria-label={t('关闭导航菜单')}
            onClick={() => setNavOpen(false)}
          >
            {icon('x', { size: 14 })}
          </button>
        </div>

        <button className="csl-back" type="button" onClick={onClose}>
          {icon('arrow-left', { size: 14 })}
          {t('返回工作区')}
        </button>

        <nav className="csl-nav" aria-label={t('控制台导航')} ref={navRef}>
          <Menu
            mode="inline"
            className="csl-menu"
            selectedKeys={[entry.key]}
            onClick={({ key }) => pick(key)}
            items={navItems}
          />
        </nav>

        <div className="csl-rail-foot">
          <div className="csl-workspace">
            <span className="csl-avatar" aria-hidden="true">
              {workspacePath === ''
                ? 'O'
                : (workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? 'O')
                    .slice(0, 1)
                    .toUpperCase()}
            </span>
            <span className="csl-workspace-text">
              <span className="csl-workspace-name" title={workspacePath}>
                {workspacePath === ''
                  ? t('未定位工作区')
                  : (workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath)}
              </span>
              <span className="csl-workspace-sub">{t('本机工作区')}</span>
            </span>
          </div>
          <div className="csl-conn" role="status" aria-live="polite">
            <span
              className={
                'csl-conn-dot' +
                (connState === 'open' ? ' on' : connState === 'connecting' ? ' warn' : '')
              }
              aria-hidden="true"
            />
            {connState === 'open'
              ? t('已连接')
              : connState === 'connecting'
                ? t('重连中')
                : t('断开')}
          </div>
        </div>
      </aside>

      <div className="csl-main">
        <div className="sp-top csl-mobilebar">
          <button
            className="iconbtn csl-menu"
            type="button"
            aria-label={t('打开导航菜单')}
            onClick={() => setNavOpen((prev) => !prev)}
          >
            {icon('menu', { size: 16 })}
          </button>
          <span className="csl-mobile-title">{t(entry.label)}</span>
          <span className="flex-spacer" aria-hidden="true" />
          <button
            className="iconbtn"
            type="button"
            aria-label={t('关闭控制台')}
            title={t('关闭（Esc）')}
            onClick={onClose}
          >
            {icon('x', { size: 15 })}
          </button>
        </div>

        <div ref={contentRef} className="sp-content csl-scroll panel-surface">
          <div className="csl-page">
            <header className="csl-head">
              <h1 className="csl-title">{t(entry.label)}</h1>
              <div className="csl-head-meta">
                {/* scope chip 仍用 `scope-` 前缀：裸 `session` 会撞上全局会话行样式。 */}
                <span
                  className={'scope-chip scope-' + scope}
                  title={t(entry.kind === 'panel' ? panelScopeOf(entry.key).hint : entry.hint)}
                >
                  {scopeText}
                </span>
                {entry.kind === 'panel' && scope === 'session' ? (
                  <span
                    key={sessionTick}
                    className={'live-dot' + (hasSession ? ' on' : '')}
                    title={t('数据实时跟随会话（回合推进自动刷新）')}
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            </header>

            {isSettingKey(entry.key) ? (
              <SettingsSurface tab={entry.key} {...settings} onNavigate={pick} />
            ) : (
              <div className="csl-panel">{panelContent}</div>
            )}
          </div>
        </div>
      </div>

      {navOpen ? (
        <div className="csl-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
      ) : null}
    </div>
  );
}
