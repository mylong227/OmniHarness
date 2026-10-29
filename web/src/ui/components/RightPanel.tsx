// 右栏容器（截图式三栏壳）：**代码查看器 + 网页标签**。
//
// 2026-10-19 起，功能面板不再从这里以「标签」形式出现，而是改为「左导航 + 右内容」的
// 页面；2026-10-26 起该页面与设置合并为工作台控制台（`components/console/ConsoleView.tsx`）。
// 本组件因此只负责两类**内容视**：
//   · 文件标签条 / 路径栏 / 只读内容（FileTab，由调用方作为 children 注入）；
//   · 网页标签（BrowserPane，由调用方作为 browserContent 注入）——2026-10-19 新增：
//     右栏可以直接浏览/预览网页，文件路径栏对 HTML 还给出「预览」入口。
//
// a11y：标签条自 2026-10-29（W2）起是 antd `Tabs`——role=tablist/tab、aria-selected、roving
// tabindex 由组件库给；**面板仍由本组件持有**（`#right-pane`，唯一可见的 tabpanel）。rc-tabs 只给
// tab 自动 id，tablist 不给 aria-label，因此在布局阶段补齐三处关系（见 `RightPanel` 的
// `useLayoutEffect`）：tablist 的 aria-label、每个 tab 的 aria-controls → `#right-pane`、
// 面板的 aria-labelledby → 当前 tab 的 id。关闭「×」由 antd 的 editable-card 渲染；
// 键盘关闭走 Delete/Backspace，←/→ 仍是「移动并切换」（与迁移前一致）。

import * as React from 'react';
import { Tabs, type TabsProps } from 'antd';
import { FileKindClassifier } from '../models/FileKindClassifier.ts';
import { icon } from '../models/Icon.ts';
import type { BrowserView, FileView } from '../shared.ts';
import { t } from '../i18n/i18n.ts';

/** 网页标签在 antd Tabs 里的 key（文件标签用文件标题，不会撞）。 */
const WEB_KEY = 'web';

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

/**
 * 右栏标签条（antd `Tabs`）：标签与**内容面板**都由 antd 持有——它给每个 tab 生成 id，
 * 面板自动带 `id` / `aria-labelledby` / `aria-controls`，比我们自己拼 id 更稳（rc-tabs 的 id
 * 是内部实现，手拼会随版本漂移）。
 *
 * 为什么用 editable-card：只有它自带逐个标签的关闭按钮与溢出滚动；`hideAdd` 关掉「+」。
 * `destroyOnHidden` 保证非当前面板卸载——否则文件内容（同一节点）会被每个标签各挂一份。
 * 容器仍是 `.tabs.rv-tabs`，右侧「在右侧打开网页」按钮走 `tabBarExtraContent`。
 *
 * @param props 标签数据、回调与面板内容
 * @returns 标签条节点
 */
function TabBar(props: {
  openFiles: readonly FileView[];
  browserOpen: boolean;
  browserActive: boolean;
  activeFile: FileView | undefined;
  tabCount: number;
  onShowFile: (title: string) => void;
  onCloseFile: (title: string) => void;
  onShowBrowser?: (() => void) | undefined;
  onCloseBrowser?: (() => void) | undefined;
  onOpenBrowser?: (() => void) | undefined;
  /** 文件面板内容（路径栏 + 文件体）。 */
  paneContent: React.ReactNode;
  /** 网页面板内容。 */
  browserContent: React.ReactNode;
}): ReactElement {
  const {
    openFiles,
    browserOpen,
    browserActive,
    activeFile,
    tabCount,
    onShowFile,
    onCloseFile,
    onShowBrowser,
    onCloseBrowser,
    onOpenBrowser,
    paneContent,
    browserContent,
  } = props;
  const items: TabsProps['items'] = openFiles.map((file) => ({
    key: file.title,
    closable: true,
    label: <span className="rv-tab-label">{file.title.split(/[\\/]/).pop() ?? file.title}</span>,
    children: paneContent,
  }));
  if (browserOpen) {
    items.push({
      key: WEB_KEY,
      closable: true,
      label: (
        <span className="rv-tab-label">
          {icon('globe', { size: 12 })} {t('网页')}
        </span>
      ),
      children: browserContent,
    });
  }
  return (
    <div className="tabs rv-tabs">
      {tabCount === 0 ? null : (
        <Tabs
          className="rv-tabbar"
          type="editable-card"
          hideAdd
          size="small"
          destroyOnHidden
          activeKey={browserActive ? WEB_KEY : activeFile?.title}
          onChange={(key) => {
            if (key === WEB_KEY) onShowBrowser?.();
            else onShowFile(key);
          }}
          onEdit={(target, action) => {
            if (action !== 'remove' || typeof target !== 'string') return;
            if (target === WEB_KEY) onCloseBrowser?.();
            else onCloseFile(target);
          }}
          tabBarExtraContent={
            browserOpen || onOpenBrowser === undefined ? null : (
              <button
                className="iconbtn rv-web-open"
                type="button"
                title={t('在右侧打开网页')}
                aria-label={t('在右侧打开网页')}
                onClick={onOpenBrowser}
              >
                {icon('globe', { size: 16 })}
              </button>
            )
          }
          items={items}
        />
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
 * 当前文件的路径文本。
 * @param activeFile 当前文件。
 * @returns 路径文本（无激活文件时为空串）
 */
function pathTextOf(activeFile: FileView | undefined): string {
  return activeFile !== undefined ? activeFile.title : '';
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
  const { activeFile, tabCount } = deriveTabs(
    openFiles,
    activeFileTitle,
    browserActive,
    browserOpen,
  );
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // rc-tabs 不给 tablist 的 aria-label（面板的 id / aria-labelledby / aria-controls 由它自动给，
  // 因此这里**不再手写**那三处关系——rc-tabs 的 id 首帧为空、后续渲染才就绪，手写会被覆盖）。
  // 每次提交后幂等重写：nav 在主题/尺寸变化时可能重建，写一次会丢。
  React.useLayoutEffect(() => {
    const list = rootRef.current?.querySelector('[role="tablist"]');
    if (list !== null && list !== undefined) {
      list.setAttribute('aria-label', browserOpen ? t('文件与网页') : t('文件'));
    }
  });

  /**
   * 标签键盘行为：←/→ 移动并切换（保留迁移前行为——rc-tabs 默认只移焦点、要 Enter 才切）；
   * Delete/Backspace 关闭**事件所在**的标签（按 items 顺序定位：文件在前、网页在末）。
   *
   * 为什么按事件目标而不是 props 判断：点击/按键可能先于父组件重渲染到达，
   * 用 props 的 `browserActive` 会把「刚点上去的网页标签」误判成文件。
   *
   * @param e 键盘事件
   * @returns 无
   */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const target = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
    const tabs = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const index = target === null ? -1 : tabs.indexOf(target as HTMLElement);
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (index === openFiles.length && browserOpen) onCloseBrowser?.();
      else if (index >= 0 && index < openFiles.length) onCloseFile(openFiles[index]!.title);
      else if (browserActive) onCloseBrowser?.();
      else if (activeFile !== undefined) onCloseFile(activeFile.title);
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    e.stopPropagation();
    if (tabs.length === 0) return;
    const selected = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    const from = index >= 0 ? index : Math.max(selected, 0);
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(from + step + tabs.length) % tabs.length];
    next?.focus();
    // 走 rc-tabs 自己的入口（click）：焦点与选中态都由它维护，避免两套状态。
    next?.click();
  };

  const pathText = pathTextOf(activeFile);
  const previewable = isPreviewable(activeFile, onPreviewFile);
  // 文件面板 = 路径栏 + 文件体（路径栏只在有激活文件时出现；网页面板不带路径栏）。
  // 该节点会挂到每个文件标签上，但 `destroyOnHidden` 保证只有当前面板真正挂载。
  const paneContent = (
    <div className="rv-pane">
      {activeFile === undefined ? null : (
        <PathBar
          pathText={pathText}
          previewable={previewable}
          activeFile={activeFile}
          {...(onPreviewFile !== undefined ? { onPreview: onPreviewFile } : {})}
        />
      )}
      <div className="rv-pane-body">{children}</div>
    </div>
  );

  return (
    <div
      className={'col right' + (open ? ' open' : '')}
      style={style}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <TabBar
        openFiles={openFiles}
        browserOpen={browserOpen}
        browserActive={browserActive}
        activeFile={activeFile}
        tabCount={tabCount}
        onShowFile={onShowFile}
        onCloseFile={onCloseFile}
        {...(onShowBrowser !== undefined ? { onShowBrowser } : {})}
        {...(onCloseBrowser !== undefined ? { onCloseBrowser } : {})}
        {...(onOpenBrowser !== undefined ? { onOpenBrowser } : {})}
        paneContent={paneContent}
        browserContent={browserContent ?? null}
      />
    </div>
  );
}
