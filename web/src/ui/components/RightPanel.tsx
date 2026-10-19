// 右栏容器（截图式三栏壳）：**代码查看器**——文件标签条 + 路径栏 + 文件内容。
//
// 2026-10-19 起，功能面板不再从这里以「标签」形式出现，而是改为设置式的
// `PanelModal`（左导航 + 右内容）。本组件因此只负责**文件预览**：
// 文件标签条 / 路径栏 / 只读内容。面板入口（「全部面板」按钮）仍保留在标签条右侧。
//
// a11y：标签条保持 WAI-ARIA Tabs 语义（tablist / tab / tabpanel + aria-selected + roving
// tabindex，左右方向键移动）；关闭「×」是 aria-hidden 的指针捷径，键盘关闭走 Delete。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import * as React from 'react';
import { PanelPicker } from './PanelPicker.tsx';
import type { FileView } from '../shared.ts';
import { t } from '../i18n/i18n.ts';

/** 右栏面板内容容器 id（标签的 aria-controls 指向它）。 */
const PANE_ID = 'right-pane';

/** RightPanel 组件的入参。 */
export interface RightPanelProps {
  /** 右栏是否展开（移动端抽屉态）。 */
  open: boolean;
  /** 已打开的文件标签集合。 */
  openFiles: readonly FileView[];
  /** 当前激活文件标题（null = 没有激活文件）。 */
  activeFileTitle: string | null;
  /** 切换到某个文件。 */
  onShowFile: (title: string) => void;
  /** 关闭某个文件。 */
  onCloseFile: (title: string) => void;
  /** 打开「全部面板」模态。 */
  onOpenPanels: () => void;
  /** 收起右栏（未提供则不渲染收起按钮）。 */
  onCollapse?: (() => void) | undefined;
  /** 容器内联样式（宽度）。 */
  style?: Record<string, string> | undefined;
  /** 文件内容节点（FileTab）。 */
  children?: React.ReactNode;
}

/** 由文件标题算 DOM id（标题里的 : \ / . 会被替换成 -，保证 id 合法）。 */
function tabIdOf(file: FileView, index: number): string {
  return 'file-tab-' + String(index) + '-' + file.title.replace(/[:\\/.]/g, '-');
}

/**
 * 右栏文件预览容器：文件标签条 + 路径栏 + 只读内容。
 * @param props 组件入参
 * @returns 右栏节点
 */
export function RightPanel(props: RightPanelProps): ReactElement {
  const {
    open,
    openFiles,
    activeFileTitle,
    onShowFile,
    onCloseFile,
    onOpenPanels,
    onCollapse,
    style,
    children,
  } = props;
  const activeIdx = openFiles.findIndex((f) => f.title === activeFileTitle);
  const activeFile = activeIdx >= 0 ? openFiles[activeIdx] : undefined;

  /**
   * 标签键盘行为：左右方向键在标签间移动并激活；Delete/Backspace 关闭当前标签。
   * @param e 键盘事件
   * @param i 当前标签下标
   * @returns 无
   */
  const onTabKey = (e: React.KeyboardEvent, i: number): void => {
    if (openFiles.length === 0) return;
    const current = openFiles[i];
    if ((e.key === 'Delete' || e.key === 'Backspace') && current !== undefined) {
      e.preventDefault();
      onCloseFile(current.title);
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = openFiles[(i + step + openFiles.length) % openFiles.length];
    if (next !== undefined) onShowFile(next.title);
  };

  /** 渲染单个文件标签（关闭「×」为 aria-hidden 指针捷径）。 */
  const renderTab = (file: FileView, i: number): ReactElement => (
    <div
      key={file.title}
      id={tabIdOf(file, i)}
      className={'tab' + (i === activeIdx ? ' active' : '') + ' closable'}
      role="tab"
      aria-selected={i === activeIdx ? 'true' : 'false'}
      aria-controls={PANE_ID}
      aria-keyshortcuts="Delete"
      title={file.title}
      tabIndex={i === activeIdx ? 0 : -1}
      onClick={() => onShowFile(file.title)}
      onKeyDown={(e: React.KeyboardEvent) => onTabKey(e, i)}
    >
      <span className="tab-label">{file.title.split(/[\\/]/).pop() ?? file.title}</span>
      <span
        className="tab-x"
        aria-hidden="true"
        title={t('关闭 {name}', { name: file.title })}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onCloseFile(file.title);
        }}
      >
        ×
      </span>
    </div>
  );

  // 没有打开文件时保留一枚静态「文件」标签：标签条与 tabpanel 仍然成套，
  // 也不会让「全部面板」按钮孤零零地飘在空标签条右端。
  const emptyTab = openFiles.length === 0;
  const pathText = activeFile !== undefined ? activeFile.title : emptyTab ? t('文件') : '';

  return (
    <div className={'col right' + (open ? ' open' : '')} style={style}>
      <div className="tabs rv-tabs">
        {/* tablist 只包文件标签：「全部面板」/ 收起按钮不是 tab，放在列表外。 */}
        <div className="rv-tablist" role="tablist" aria-label={t('文件')}>
          {emptyTab ? (
            <div
              id="file-tab-empty"
              className="tab active"
              role="tab"
              aria-selected="true"
              aria-controls={PANE_ID}
              tabIndex={0}
            >
              <span className="tab-label">{t('文件')}</span>
            </div>
          ) : (
            openFiles.map((f, i) => renderTab(f, i))
          )}
        </div>
        <span className="flex-spacer" aria-hidden="true"></span>
        <PanelPicker onOpen={onOpenPanels} />
        {onCollapse === undefined ? null : (
          <button
            className="iconbtn rv-collapse"
            title={t('收起功能面板（Ctrl/Cmd+Shift+E）')}
            aria-label={t('收起功能面板')}
            onClick={onCollapse}
          >
            »
          </button>
        )}
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
        className="pane active panel-surface"
        id={PANE_ID}
        role="tabpanel"
        aria-labelledby={
          emptyTab
            ? 'file-tab-empty'
            : activeIdx >= 0 && openFiles[activeIdx] !== undefined
              ? tabIdOf(openFiles[activeIdx]!, activeIdx)
              : undefined
        }
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
