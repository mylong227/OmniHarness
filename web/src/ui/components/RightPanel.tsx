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
 * 单个文件标签。
 * @param props 文件、下标、选中态与回调。
 * @returns 标签节点。
 */
function FileTab(props: {
  file: FileView;
  index: number;
  active: boolean;
  onShow: (title: string) => void;
  onClose: (title: string) => void;
  onKey: (e: React.KeyboardEvent, index: number) => void;
}): ReactElement {
  const { file, index, active, onShow, onClose, onKey } = props;
  return (
    <div
      id={tabIdOf(file, index)}
      className={'tab' + (active ? ' active' : '') + ' closable'}
      role="tab"
      aria-selected={active ? 'true' : 'false'}
      aria-controls={PANE_ID}
      aria-keyshortcuts="Delete"
      title={file.title}
      tabIndex={active ? 0 : -1}
      onClick={() => onShow(file.title)}
      onKeyDown={(e: React.KeyboardEvent) => onKey(e, index)}
    >
      <span className="tab-label">{file.title.split(/[\\/]/).pop() ?? file.title}</span>
      <span
        className="tab-x"
        aria-hidden="true"
        title={t('关闭 {name}', { name: file.title })}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onClose(file.title);
        }}
      >
        ×
      </span>
    </div>
  );
}

/**
 * 网页标签（与文件标签同属一个 tablist）。
 * @param props 标题、选中态与回调。
 * @returns 标签节点。
 */
function WebTab(props: {
  title: string;
  active: boolean;
  onShow: () => void;
  onClose: () => void;
  onKey: (e: React.KeyboardEvent, index: number) => void;
  index: number;
}): ReactElement {
  return (
    <div
      id={WEB_TAB_ID}
      className={'tab' + (props.active ? ' active' : '') + ' closable'}
      role="tab"
      aria-selected={props.active ? 'true' : 'false'}
      aria-controls={PANE_ID}
      aria-keyshortcuts="Delete"
      title={props.title}
      tabIndex={props.active ? 0 : -1}
      onClick={props.onShow}
      onKeyDown={(e: React.KeyboardEvent) => props.onKey(e, props.index)}
    >
      <span className="tab-label">
        {icon('globe', { size: 12 })} {t('网页')}
      </span>
      <span
        className="tab-x"
        aria-hidden="true"
        title={t('关闭网页标签')}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        ×
      </span>
    </div>
  );
}

/**
 * 右栏标签栏（文件标签 + 网页标签 + 打开网页按钮）。
 * @param props 标签数据与回调。
 * @returns 标签栏节点。
 */
function PanelTabs(props: {
  openFiles: readonly FileView[];
  browserOpen: boolean;
  browserActive: boolean;
  activeIdx: number;
  webTitle: string;
  tabCount: number;
  onShowFile: (title: string) => void;
  onCloseFile: (title: string) => void;
  onShowBrowser?: (() => void) | undefined;
  onCloseBrowser?: (() => void) | undefined;
  onOpenBrowser?: (() => void) | undefined;
  onTabKey: (e: React.KeyboardEvent, index: number) => void;
}): ReactElement {
  const {
    openFiles,
    browserOpen,
    browserActive,
    activeIdx,
    webTitle,
    tabCount,
    onShowFile,
    onCloseFile,
    onShowBrowser,
    onCloseBrowser,
    onOpenBrowser,
    onTabKey,
  } = props;
  return (
    <div className="tabs rv-tabs">
      {tabCount === 0 ? null : (
        <div
          className="rv-tablist"
          role="tablist"
          aria-label={browserOpen ? t('文件与网页') : t('文件')}
        >
          {openFiles.map((f, i) => (
            <FileTab
              key={f.title}
              file={f}
              index={i}
              active={!browserActive && i === activeIdx}
              onShow={onShowFile}
              onClose={onCloseFile}
              onKey={onTabKey}
            />
          ))}
          {browserOpen ? (
            <WebTab
              title={webTitle}
              index={openFiles.length}
              active={browserActive}
              onShow={() => onShowBrowser?.()}
              onClose={() => onCloseBrowser?.()}
              onKey={onTabKey}
            />
          ) : null}
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
  );
}

/**
 * 文件路径栏。
 * @param props 路径、预览能力与文件。
 * @returns 路径栏节点。
 */
function PathBar(props: {
  pathText: string;
  previewable: boolean;
  activeFile: FileView;
  onPreview?: ((path: string) => Promise<void> | void) | undefined;
}): ReactElement {
  return (
    <div className="rv-pathbar">
      <span className="rv-path" title={props.pathText}>
        {props.pathText}
      </span>
      <span className="flex-spacer" aria-hidden="true"></span>
      {props.previewable ? (
        <button
          className="rv-preview"
          type="button"
          title={t('在浏览器中预览')}
          onClick={() => {
            if (props.onPreview !== undefined) void props.onPreview(props.activeFile.title);
          }}
        >
          {icon('globe', { size: 12 })} {t('预览')}
        </button>
      ) : null}
      {props.activeFile.lang !== '' ? <span className="rv-lang">{props.activeFile.lang}</span> : null}
      <span className="rv-meta">{props.activeFile.meta}</span>
    </div>
  );
}

/**
 * 右栏内容面板。
 * @param props 内容与无障碍标注。
 * @returns 面板节点。
 */
function PanelBody(props: {
  labelledBy: string | undefined;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      className="pane active panel-surface"
      id={PANE_ID}
      role="tabpanel"
      aria-labelledby={props.labelledBy}
      tabIndex={-1}
    >
      {props.children}
    </div>
  );
}

/**
 * 标签键盘行为：左右移动、Delete/Backspace 关闭。
 * @param e 键盘事件。
 * @param index 当前标签下标。
 * @param ctx 标签上下文。
 * @returns 无。
 */
function handleTabKey(
  e: React.KeyboardEvent,
  index: number,
  ctx: {
    tabCount: number;
    fileCount: number;
    files: readonly FileView[];
    closeBrowser: () => void;
    closeFile: (title: string) => void;
    showBrowser: () => void;
    showFile: (title: string) => void;
  },
): void {
  if (ctx.tabCount === 0) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (index === ctx.fileCount) {
      ctx.closeBrowser();
      return;
    }
    const current = ctx.files[index];
    if (current !== undefined) ctx.closeFile(current.title);
    return;
  }
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  const step = e.key === 'ArrowRight' ? 1 : -1;
  const next = (index + step + ctx.tabCount) % ctx.tabCount;
  if (next === ctx.fileCount) {
    ctx.showBrowser();
    return;
  }
  const file = ctx.files[next];
  if (file !== undefined) ctx.showFile(file.title);
}

/**
 * 判断当前文件能否在浏览器中预览。
 * @param file 当前文件。
 * @param onPreview 预览回调。
 * @returns 可预览为 true。
 */
function isPreviewable(
  file: FileView | undefined,
  onPreview: ((path: string) => Promise<void> | void) | undefined,
): boolean {
  return (
    file !== undefined &&
    onPreview !== undefined &&
    FileKindClassifier.isWebPage(file.lang === '' ? file.title : file.lang)
  );
}

/**
 * 右栏文本（路径与网页标题）。
 * @param activeFile 当前文件。
 * @param browser 网页状态。
 * @returns 路径文本与网页标签标题。
 */
function panelTexts(
  activeFile: FileView | undefined,
  browser: { title?: string | undefined } | undefined,
): { pathText: string; webTitle: string } {
  return {
    pathText: activeFile !== undefined ? activeFile.title : '',
    webTitle: browser?.title !== undefined && browser.title !== '' ? browser.title : t('网页'),
  };
}

/**
 * 面板的 aria-labelledby。
 * @param browserActive 网页是否激活。
 * @param activeIdx 文件下标。
 * @param openFiles 已打开文件。
 * @returns 标签 id 或 undefined。
 */
function labelledByOf(
  browserActive: boolean,
  activeIdx: number,
  openFiles: readonly FileView[],
): string | undefined {
  if (browserActive) return WEB_TAB_ID;
  return activeIdx >= 0 && openFiles[activeIdx] !== undefined
    ? tabIdOf(openFiles[activeIdx]!, activeIdx)
    : undefined;
}

/**
 * 推导当前文件 / 标签数量。
 * @param openFiles 已打开文件。
 * @param activeFileTitle 当前文件标题。
 * @param browserActive 网页标签是否激活。
 * @param browserOpen 网页标签是否存在。
 * @returns 激活下标、激活文件与标签总数。
 */
function deriveTabs(
  openFiles: readonly FileView[],
  activeFileTitle: string | null | undefined,
  browserActive: boolean,
  browserOpen: boolean,
): { activeIdx: number; activeFile: FileView | undefined; tabCount: number } {
  const activeIdx = browserActive ? -1 : openFiles.findIndex((f) => f.title === activeFileTitle);
  const activeFile = activeIdx >= 0 ? openFiles[activeIdx] : undefined;
  return { activeIdx, activeFile, tabCount: openFiles.length + (browserOpen ? 1 : 0) };
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
  const { activeIdx, activeFile, tabCount } = deriveTabs(
    openFiles,
    activeFileTitle,
    browserActive,
    browserOpen,
  );

  /**
   * 标签键盘行为：左右方向键在全部标签（文件 + 网页）间移动并激活；
   * Delete/Backspace 关闭当前标签（网页标签关闭整页，不清理地址）。
   * @param e 键盘事件
   * @param i 当前标签下标（等于 openFiles.length 表示网页标签）
   * @returns 无
   */
  const onTabKey = (e: React.KeyboardEvent, i: number): void =>
    handleTabKey(e, i, {
      tabCount,
      fileCount: openFiles.length,
      files: openFiles,
      closeBrowser: () => onCloseBrowser?.(),
      closeFile: onCloseFile,
      showBrowser: () => onShowBrowser?.(),
      showFile: onShowFile,
    });

  const { pathText, webTitle } = panelTexts(activeFile, browser);
  const previewable = isPreviewable(activeFile, onPreviewFile);

  return (
    <div className={'col right' + (open ? ' open' : '')} style={style}>
      <PanelTabs
        openFiles={openFiles}
        browserOpen={browserOpen}
        browserActive={browserActive}
        activeIdx={activeIdx}
        webTitle={webTitle}
        tabCount={tabCount}
        onShowFile={onShowFile}
        onCloseFile={onCloseFile}
        {...(onShowBrowser !== undefined ? { onShowBrowser } : {})}
        {...(onCloseBrowser !== undefined ? { onCloseBrowser } : {})}
        {...(onOpenBrowser !== undefined ? { onOpenBrowser } : {})}
        onTabKey={onTabKey}
      />
      {activeFile === undefined || browserActive ? null : (
        <PathBar
          pathText={pathText}
          previewable={previewable}
          activeFile={activeFile}
          {...(onPreviewFile !== undefined ? { onPreview: onPreviewFile } : {})}
        />
      )}
      <PanelBody labelledBy={labelledByOf(browserActive, activeIdx, openFiles)}>
        {browserActive && browserContent !== undefined ? browserContent : children}
      </PanelBody>
    </div>
  );
}
