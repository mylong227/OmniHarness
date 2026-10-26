// 右栏容器（截图式三栏壳）：**代码查看器 + 网页标签**。
//
// 2026-10-19 起，功能面板不再从这里以「标签」形式出现，而是改为「左导航 + 右内容」的
// 页面；2026-10-26 起该页面与设置合并为工作台控制台（`components/console/ConsoleView.tsx`）。
// 本组件因此只负责两类**内容视**：
//   · 文件标签条 / 路径栏 / 只读内容（FileTab，由调用方作为 children 注入）；
//   · 网页标签（BrowserPane，由调用方作为 browserContent 注入）——2026-10-19 新增：
//     右栏可以直接浏览/预览网页，文件路径栏对 HTML 还给出「预览」入口。
//
// a11y：标签条保持 WAI-ARIA Tabs 语义（tablist / tab / tabpanel + aria-selected + roving
// tabindex，左右方向键移动）；关闭「×」是 aria-hidden 的指针捷径，键盘关闭走 Delete。
// 网页标签与文件标签同属一个 tablist（键盘能一路走到），只是 key/id 前缀不同。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import * as React from 'react';
import { FileKindClassifier } from '../models/FileKindClassifier.ts';
import { icon } from '../models/Icon.ts';
import type { BrowserView, FileView } from '../shared.ts';
import { t } from '../i18n/i18n.ts';

/** 右栏面板内容容器 id（标签的 aria-controls 指向它）。 */
const PANE_ID = 'right-pane';

/** 网页标签的稳定 DOM id。 */
const WEB_TAB_ID = 'web-tab';

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
  /** 容器内联样式（宽度）。 */
  style?: Record<string, string> | undefined;
  /** 文件内容节点（FileTab）。 */
  children?: React.ReactNode;
  /**
   * 网页标签状态（缺省 = 没有网页标签；旧调用方/判据不必补这个 prop）。
   * `open` 控制标签是否存在，`active` 控制当前显示网页还是文件。
   */
  browser?: BrowserView | undefined;
  /** 网页内容节点（BrowserPane）；仅在网页标签激活时渲染。 */
  browserContent?: React.ReactNode;
  /** 打开（或切回）网页标签的入口按钮（网页标签未打开时显示）。 */
  onOpenBrowser?: (() => void) | undefined;
  /** 点击网页标签。 */
  onShowBrowser?: (() => void) | undefined;
  /** 关闭网页标签。 */
  onCloseBrowser?: (() => void) | undefined;
  /** 预览当前激活的 HTML 文件（路径栏的「预览」按钮）。 */
  onPreviewFile?: ((path: string) => void) | undefined;
}

/** 由文件标题算 DOM id（标题里的 : \ / . 会被替换成 -，保证 id 合法）。 */
function tabIdOf(file: FileView, index: number): string {
  return 'file-tab-' + String(index) + '-' + file.title.replace(/[:\\/.]/g, '-');
}

/**
 * 右栏容器：文件标签 / 网页标签 + 路径栏 + 内容区。
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
    style,
    children,
    browser,
    browserContent,
    onOpenBrowser,
    onShowBrowser,
    onCloseBrowser,
    onPreviewFile,
  } = props;
  const browserOpen = browser?.open === true;
  const browserActive = browserOpen && browser.active === true;
  const activeIdx = browserActive ? -1 : openFiles.findIndex((f) => f.title === activeFileTitle);
  const activeFile = activeIdx >= 0 ? openFiles[activeIdx] : undefined;
  const tabCount = openFiles.length + (browserOpen ? 1 : 0);

  /**
   * 标签键盘行为：左右方向键在全部标签（文件 + 网页）间移动并激活；
   * Delete/Backspace 关闭当前标签（网页标签关闭整页，不清理地址）。
   * @param e 键盘事件
   * @param i 当前标签下标（等于 openFiles.length 表示网页标签）
   * @returns 无
   */
  const onTabKey = (e: React.KeyboardEvent, i: number): void => {
    if (tabCount === 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (i === openFiles.length) {
        onCloseBrowser?.();
        return;
      }
      const current = openFiles[i];
      if (current !== undefined) onCloseFile(current.title);
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = (i + step + tabCount) % tabCount;
    if (next === openFiles.length) {
      onShowBrowser?.();
      return;
    }
    const file = openFiles[next];
    if (file !== undefined) onShowFile(file.title);
  };

  /** 渲染单个文件标签（关闭「×」为 aria-hidden 指针捷径）。 */
  const renderTab = (file: FileView, i: number): ReactElement => {
    const selected = !browserActive && i === activeIdx;
    return (
      <div
        key={file.title}
        id={tabIdOf(file, i)}
        className={'tab' + (selected ? ' active' : '') + ' closable'}
        role="tab"
        aria-selected={selected ? 'true' : 'false'}
        aria-controls={PANE_ID}
        aria-keyshortcuts="Delete"
        title={file.title}
        tabIndex={selected ? 0 : -1}
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
  };

  /** 渲染网页标签（与文件标签同属一个 tablist）。 */
  const renderWebTab = (): ReactElement | null => {
    if (!browserOpen) return null;
    // 标签文案固定为「网页」：打开 HTML 时文件标签与网页标签会同时存在（源码 / 渲染），
    // 两者同名会让用户分不清哪个是源码；当前地址放在 title 悬浮里。
    const label = t('网页');
    const title = browser?.title !== undefined && browser.title !== '' ? browser.title : label;
    return (
      <div
        id={WEB_TAB_ID}
        className={'tab' + (browserActive ? ' active' : '') + ' closable'}
        role="tab"
        aria-selected={browserActive ? 'true' : 'false'}
        aria-controls={PANE_ID}
        aria-keyshortcuts="Delete"
        title={title}
        tabIndex={browserActive ? 0 : -1}
        onClick={() => onShowBrowser?.()}
        onKeyDown={(e: React.KeyboardEvent) => onTabKey(e, openFiles.length)}
      >
        <span className="tab-label">
          {icon('globe', { size: 12 })} {label}
        </span>
        <span
          className="tab-x"
          aria-hidden="true"
          title={t('关闭网页标签')}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onCloseBrowser?.();
          }}
        >
          ×
        </span>
      </div>
    );
  };

  // 没有打开任何文件 / 网页时不渲染假标签（用户要求「把文件标签删除」）：只留工具按钮。
  const pathText = activeFile !== undefined ? activeFile.title : '';
  const previewable =
    activeFile !== undefined &&
    onPreviewFile !== undefined &&
    FileKindClassifier.isWebPage(activeFile.lang === '' ? activeFile.title : activeFile.lang);

  return (
    <div className={'col right' + (open ? ' open' : '')} style={style}>
      <div className="tabs rv-tabs">
        {/* tablist 只包标签：「全部面板」/ 打开网页按钮不是 tab，放在列表外。 */}
        {tabCount === 0 ? null : (
          <div
            className="rv-tablist"
            role="tablist"
            aria-label={browserOpen ? t('文件与网页') : t('文件')}
          >
            {openFiles.map((f, i) => renderTab(f, i))}
            {renderWebTab()}
          </div>
        )}
        <span className="flex-spacer" aria-hidden="true"></span>
        {browserOpen || onOpenBrowser === undefined ? null : (
          <button
            className="iconbtn rv-web-open"
            type="button"
            title={t('在右侧打开网页')}
            aria-label={t('在右侧打开网页')}
            onClick={onOpenBrowser}
          >
            {icon('globe', { size: 16 })}
          </button>
        )}
      </div>
      {activeFile === undefined || browserActive ? null : (
        <div className="rv-pathbar">
          <span className="rv-path" title={pathText}>
            {pathText}
          </span>
          <span className="flex-spacer" aria-hidden="true"></span>
          {previewable ? (
            <button
              className="rv-preview"
              type="button"
              title={t('在浏览器中预览')}
              onClick={() => {
                if (onPreviewFile !== undefined) void onPreviewFile(activeFile.title);
              }}
            >
              {icon('globe', { size: 12 })} {t('预览')}
            </button>
          ) : null}
          {activeFile.lang !== '' ? <span className="rv-lang">{activeFile.lang}</span> : null}
          <span className="rv-meta">{activeFile.meta}</span>
        </div>
      )}
      <div
        className="pane active panel-surface"
        id={PANE_ID}
        role="tabpanel"
        aria-labelledby={
          browserActive
            ? WEB_TAB_ID
            : activeIdx >= 0 && openFiles[activeIdx] !== undefined
              ? tabIdOf(openFiles[activeIdx]!, activeIdx)
              : undefined
        }
        tabIndex={-1}
      >
        {browserActive && browserContent !== undefined ? browserContent : children}
      </div>
    </div>
  );
}
