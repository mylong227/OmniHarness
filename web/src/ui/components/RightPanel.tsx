// 右栏容器（截图式三栏壳）：**代码查看器**——文件标签条 + 路径栏 + 当前面板插槽。
// 原先常驻的 12 个功能标签全部收进「全部面板」菜单（PanelPicker）；激活某个功能面板时，
// 它以一个可关闭的标签出现在文件标签之后（关闭即回到文件视图）。各具体面板仍由 App 按
// activePane 选择后作为 children 注入，本组件不做业务逻辑。
//
// a11y：标签条保持 WAI-ARIA Tabs 语义（tablist / tab / tabpanel + aria-selected + roving
// tabindex，左右方向键移动）——与旧标签条同一套契约，采集脚本按 [role="tab"] 采集的口径不变。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import { React } from '../deps.js';
import { PanelPicker } from './PanelPicker.js';
import { panelOf } from '../models/PanelRegistry.js';
import type { FileView } from '../shared.js';

/** 右栏面板内容容器 id（标签的 aria-controls 指向它）。 */
const PANE_ID = 'right-pane';

/** 标签条里的一个渲染条目（文件标签或功能面板标签的统一形态）。 */
interface TabItem {
  /** 稳定 key。 */
  readonly key: string;
  /** 标签文案（文件显示基名，完整路径进 title）。 */
  readonly label: string;
  /** 悬停提示（文件为完整路径；面板为面板名）。 */
  readonly title: string;
  /** 是否激活。 */
  readonly active: boolean;
  /** 可关闭（文件标签都可关；面板标签在非 file 视图时可关回文件）。 */
  readonly closable: boolean;
}

/** RightPanel 组件的入参。 */
export interface RightPanelProps {
  /** 当前激活的面板标识。 */
  activePane: string;
  /** 切换面板。 */
  onSelect: (pane: string) => void;
  /** 右栏是否展开（移动端抽屉态）。 */
  open: boolean;
  /** 代码查看器已打开的文件（标签条渲染源；缺省空）。 */
  openFiles?: FileView[];
  /** 当前激活的文件路径（file 面板下高亮对应标签）。 */
  activeFileTitle?: string | null;
  /** 点击文件标签（切换到该文件，不重新读盘）。 */
  onShowFile?: (title: string) => void;
  /** 关闭文件标签（若是当前文件，上层自动回落到相邻标签）。 */
  onCloseFile?: (title: string) => void;
  /**
   * 当前面板内容（由 App 按 activePane 选择后注入）。
   *
   * 为什么是可选：App 以 `React.createElement(RightPanel, props, pane)` 的**第三参数**传子节点
   * （React 的标准写法），此时 `props` 里本就没有 `children`。
   */
  children?: ReactNode;
  /** 移动端内联样式覆盖。 */
  style?: Record<string, string>;
}

/**
 * 组装标签条条目：已打开文件 + （非 file 视图时的）功能面板标签。
 * @param props 组件入参
 * @returns 标签条目列表
 */
function buildTabs(props: RightPanelProps): TabItem[] {
  const { openFiles, activePane, activeFileTitle } = props;
  const items: TabItem[] = (openFiles ?? []).map((f) => ({
    key: 'file:' + f.title,
    label: f.title.split('\\').pop()!.split('/').pop()!,
    title: f.title,
    active: activePane === 'file' && f.title === (activeFileTitle ?? null),
    closable: true,
  }));
  if (activePane !== 'file') {
    const p = panelOf(activePane);
    if (p !== undefined) {
      items.push({
        key: 'pane:' + p.key,
        label: p.label,
        title: p.label + '（点 × 回到文件）',
        active: true,
        closable: true,
      });
    }
  }
  return items;
}

/**
 * 右栏代码查看器：渲染标签条（tablist）、路径栏与当前面板内容（tabpanel）。
 * @param props 组件入参
 * @returns 右栏节点
 */
export function RightPanel(props: RightPanelProps): ReactElement {
  const { activePane, onSelect, open, openFiles, activeFileTitle, onShowFile, onCloseFile, children, style } =
    props;
  const items = buildTabs(props);
  /** roving tabindex 的当前下标（激活项进 Tab 序列，其余 -1）。 */
  const activeIdx = items.findIndex((t) => t.active);

  /**
   * 标签键盘行为：左右方向键在标签间循环移动并激活，Enter/Space 激活当前标签。
   * @param e 键盘事件
   * @param i 当前标签下标
   * @returns 无
   */
  const onTabKey = (e: React.KeyboardEvent, i: number): void => {
    if (items.length === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const next = items[(i + step + items.length) % items.length];
      activate(next);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(items[i]);
    }
  };

  /**
   * 激活一个标签：文件标签走 onShowFile，面板标签走 onSelect。
   * @param t 标签条目（undefined 时忽略）
   * @returns 无
   */
  const activate = (t: TabItem | undefined): void => {
    if (t === undefined) return;
    if (t.key.startsWith('file:')) onShowFile?.(t.title);
    else onSelect(t.key.startsWith('pane:') ? t.key.slice(5) : t.key);
  };

  /**
   * 关闭一个标签：文件标签走 onCloseFile；面板标签关闭即回文件视图。
   * @param e 点击事件（阻断冒泡，避免先触发标签激活）
   * @param t 标签条目
   * @returns 无
   */
  const closeTab = (e: React.MouseEvent, t: TabItem): void => {
    e.stopPropagation();
    if (t.key.startsWith('file:')) onCloseFile?.(t.title);
    else onSelect(openFiles !== undefined && openFiles.length > 0 ? 'file' : 'tools');
  };

/** 由标签 key 算 DOM id（key 里的 : \ / . 会被替换成 -，保证 id 合法）。 */
function tabIdOf(t: TabItem): string {
  return 'tab-' + t.key.replace(/[:\\/.]/g, '-');
}

/** 渲染单个标签：选中态由 active 决定（roving tabindex：只有激活项进 Tab 序列）。 */
const renderTab = (t: TabItem, i: number): ReactElement => (
  <div
    key={t.key}
    id={tabIdOf(t)}
      className={'tab' + (t.active ? ' active' : '')}
      role="tab"
      aria-selected={t.active ? 'true' : 'false'}
      aria-controls={PANE_ID}
      title={t.title}
      tabIndex={i === activeIdx ? 0 : -1}
      onClick={() => activate(t)}
      onKeyDown={(e: React.KeyboardEvent) => onTabKey(e, i)}
    >
      <span className="tab-label">{t.label}</span>
      {t.closable ? (
        <span
          className="tab-x"
          role="button"
          aria-label={'关闭 ' + t.label}
          tabIndex={-1}
          onClick={(e: React.MouseEvent) => closeTab(e, t)}
        >
          ×
        </span>
      ) : null}
    </div>
  );

  const activeFile =
    activePane === 'file' ? (openFiles ?? []).find((f) => f.title === (activeFileTitle ?? null)) : undefined;
  const currentPanel = panelOf(activePane);
  // 路径栏：文件视图显示完整路径，面板视图显示面板组名（注册表顺序段名的人话口径）。
  const pathText =
    activeFile !== undefined ? activeFile.title : currentPanel !== undefined ? currentPanel.label + ' 面板' : '';
  return (
    <div className={'col right' + (open ? ' open' : '')} style={style}>
      <div className="tabs rv-tabs" role="tablist" aria-label="文件与面板">
        {items.map((t, i) => renderTab(t, i))}
        <span className="flex-spacer" aria-hidden="true"></span>
        <PanelPicker activePane={activePane} onPick={onSelect} />
      </div>
      <div className="rv-pathbar">
        <span className="rv-path" title={pathText}>
          {pathText}
        </span>
        <span className="flex-spacer" aria-hidden="true"></span>
        {activeFile !== undefined && activeFile.lang !== '' ? (
          <span className="rv-lang">{activeFile.lang}</span>
        ) : null}
        {activeFile !== undefined ? <span className="rv-meta">{activeFile.meta}</span> : null}
      </div>
      <div
        className="pane active"
        id={PANE_ID}
        role="tabpanel"
        aria-labelledby={
          items[activeIdx === -1 ? 0 : activeIdx] !== undefined
            ? tabIdOf(items[activeIdx === -1 ? 0 : activeIdx]!)
            : undefined
        }
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
