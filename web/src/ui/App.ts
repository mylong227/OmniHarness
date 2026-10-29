// 应用根组件：纯视图层（C3 拆分后的标准写法）。
// 状态与副作用全部上移到 AppController（组合根 / 门面）+ 子控制器（Session / Composer / Graph），
// 本组件只负责「状态 → DOM 树」的装配，不含任何业务副作用
// （回调统一经 controller.* 命名引用，App 状态即唯一数据源）。
//
// 函数组件范式：根状态用 useState（惰性初始化）+ 函数式 updater 承接 AppHost.patch；
// 控制器只构造一次（useRef 惰性初始化），host 桥接到「稳定的 setState + 最新状态 ref」，
// 故 patch 永不读到陈旧快照（H5）；挂载启动 / 卸载清理由依赖 [controller] 的 effect 承接。

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { AppContext } from './context.ts';
import { AppController } from './controllers/AppController.ts';
import type { AppHost, AppState } from './controllers/AppController.ts';
import { getLocale, initLocale, t, type Locale } from './i18n/i18n.ts';
import type { ThemePreference } from './models/ThemePreference.ts';

import { RenderErrorBoundary } from './components/RenderErrorBoundary.tsx';
import { SessionPanel } from './components/SessionPanel.tsx';
import { StreamView } from './components/StreamView.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import { BrowserPane } from './components/BrowserPane.tsx';
import { ConsoleView } from './components/console/ConsoleView.tsx';
import { isSettingKey } from './models/ConsoleRegistry.ts';
import { ApprovalModal } from './components/ApprovalModal.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Toast } from './components/Toast.tsx';
import { DialogHost } from './components/DialogHost.tsx';
import { TooltipLayer } from './components/TooltipLayer.tsx';
import { Resizer } from './components/Resizer.tsx';

// antd 运行时装配（W1 起）：全站唯一 ConfigProvider/AntApp 收口在 ThemeProvider。
// theme 直接取根状态 state.theme（LayoutController 已按 themePref 解析成 dark/light）。
import { ThemeProvider } from './theme/ThemeProvider.tsx';

import { ToolsTab } from './components/tabs/ToolsTab.tsx';
import { MetricsTab } from './components/tabs/MetricsTab.tsx';
import { ChangesTab } from './components/tabs/ChangesTab.tsx';
import { PluginsTab } from './components/tabs/PluginsTab.tsx';
import { FileTab } from './components/tabs/FileTab.tsx';
import { DetailTab } from './components/tabs/DetailTab.tsx';
import { TraceTab } from './components/tabs/TraceTab.tsx';
import { PermissionTab } from './components/tabs/PermissionTab.tsx';

// 「少见面板」按需加载 + **空闲期预取**（2026-10-18 重做）：
// 第一版只做 `React.lazy`，实测首次点开会出现 200–300 ms 的「加载中…」——那比省下的
// 8.7 KB gzip 更伤体验，于是回退。现在的做法是两件事一起做：
//   ① lazy：入口不再包含这 8 个面板（首屏解析更小）；
//   ② 挂载后空闲期**异步预取**全部 chunk（不阻塞首屏）——用户真正点开时 chunk 已在缓存里，
//      打开零等待。预取失败也无妨：Suspense fallback 仍在，只是回到"首开等一下"。
const GraphTab = React.lazy(() =>
  import('./components/tabs/GraphTab.tsx').then((m) => ({ default: m.GraphTab })),
);
const ActivityTab = React.lazy(() =>
  import('./components/tabs/ActivityTab.tsx').then((m) => ({ default: m.ActivityTab })),
);
const SkillsTab = React.lazy(() =>
  import('./components/tabs/SkillsTab.tsx').then((m) => ({ default: m.SkillsTab })),
);
const AutomationsTab = React.lazy(() =>
  import('./components/tabs/AutomationsTab.tsx').then((m) => ({ default: m.AutomationsTab })),
);
const MemoryTab = React.lazy(() =>
  import('./components/tabs/MemoryTab.tsx').then((m) => ({ default: m.MemoryTab })),
);
const ProfilesTab = React.lazy(() =>
  import('./components/tabs/ProfilesTab.tsx').then((m) => ({ default: m.ProfilesTab })),
);
const RollbackTab = React.lazy(() =>
  import('./components/tabs/RollbackTab.tsx').then((m) => ({ default: m.RollbackTab })),
);
const GovernanceTab = React.lazy(() =>
  import('./components/tabs/GovernanceTab.tsx').then((m) => ({ default: m.GovernanceTab })),
);
const DiagnosticsTab = React.lazy(() =>
  import('./components/tabs/DiagnosticsTab.tsx').then((m) => ({ default: m.DiagnosticsTab })),
);
const AuditTab = React.lazy(() =>
  import('./components/tabs/AuditTab.tsx').then((m) => ({ default: m.AuditTab })),
);
const VaultTab = React.lazy(() =>
  import('./components/tabs/VaultTab.tsx').then((m) => ({ default: m.VaultTab })),
);

/** 空闲期预取上面 11 个按需面板（与 lazy 的 import 一一对应）。 */
function prefetchLazyPanes(): void {
  const loaders: (() => Promise<unknown>)[] = [
    () => import('./components/tabs/ActivityTab.tsx'),
    () => import('./components/tabs/SkillsTab.tsx'),
    () => import('./components/tabs/AutomationsTab.tsx'),
    () => import('./components/tabs/GraphTab.tsx'),
    () => import('./components/tabs/MemoryTab.tsx'),
    () => import('./components/tabs/ProfilesTab.tsx'),
    () => import('./components/tabs/RollbackTab.tsx'),
    () => import('./components/tabs/GovernanceTab.tsx'),
    () => import('./components/tabs/DiagnosticsTab.tsx'),
    () => import('./components/tabs/AuditTab.tsx'),
    () => import('./components/tabs/VaultTab.tsx'),
  ];
  for (const load of loaders) {
    // 失败静默：真正打开时 Suspense 会再试一次，且 fallback 可读。
    void load().catch(() => undefined);
  }
}
import { SessionsScope } from './models/SessionsScope.ts';
import { LocalDevUrls } from './models/LocalDevUrls.ts';

/** AppHost.patch 的入参形态（局部补丁 / 函数式 updater）。 */
type AppAction = Partial<AppState> | ((prev: AppState) => Partial<AppState>);

/** 根状态初值（与拆分前的 class 构造函数逐字一致）。 */
function initialState(): AppState {
  // 语言偏好必须**首帧前**同步恢复：界面文案直接渲染在首帧，挂载后补设会闪一次语言
  // （与主题不同——主题初值 'dark' 可由 initTheme 在首帧前修正，这里没有第二机会）。
  initLocale();
  return {
    connected: false,
    // 首屏是「连接中」而不是「断开」：还没连上就报红色断开是假故障（徽标文案见 SidebarFooter）。
    streamState: 'connecting',
    adapter: '',
    activePane: 'tools',
    // 控制台默认关闭、默认落在「常规」页（点左栏页脚的设置按钮即进入）。
    settingsOpen: false,
    panelModalOpen: false,
    settingsTab: 'general',
    model: '',
    modelOptions: [],
    providerLabel: '',
    reasoning: '',
    reasoningOptions: undefined,
    permission: '',
    events: [],
    toolResults: {},
    liveInputs: [],
    sessions: [],
    currentThreadId: null,
    sessionTick: 0,
    workspaceEpoch: 0,
    detailEvent: null,
    approval: null,
    question: null,
    fileView: null,
    openFiles: [],
    // 右栏网页标签：默认关闭；地址与标题保留到用户下次打开（关闭标签不清地址）。
    browser: { open: false, active: false, url: '', title: '', reloadKey: 0, error: '' },
    theme: 'dark',
    // 主题偏好初值：`system`（跟随系统）。真正的解析在 LayoutController.initTheme 完成，
    // 首帧前的 data-theme 由 index.html 的内联脚本按 prefers-color-scheme 设好。
    themePref: 'system',
    locale: getLocale(),
    leftOpen: false,
    rightOpen: false,
    // 桌面右栏收起态的本机偏好在 LayoutController.initTheme 里恢复；首屏先展开。
    rightCollapsed: false,
    memoryReloadKey: 0,
    profilesReloadKey: 0,
    graphRuns: {},
    busy: false,
    activeTool: null,
    toastState: { seq: 0, message: '', kind: 'info', visible: false },
    paletteOpen: false,
    sessionsScopeAll: SessionsScope.read() === 'all',
    dialog: { request: null },
    streamText: '',
    finalizedStreamText: '',
    composerSeed: null,
    historyHasMore: false,
    oldestEventId: null,
    historyLoading: false,
    leftWidth: 248,
    rightWidth: 420,
  };
}

/**
 * 把「局部补丁 / 函数式 updater」合并进当前状态（等价 setState 的浅合并语义）。
 * @param prev 当前状态
 * @param action 补丁或基于前态的 updater
 * @returns 合并后的新状态
 */
function mergeAppPatch(prev: AppState, action: AppAction): AppState {
  const patch = typeof action === 'function' ? action(prev) : action;
  return { ...prev, ...patch };
}

/**
 * 按当前激活面板选择右侧内容面板。
 * @param ctrl 根控制器
 * @param s 当前状态
 * @returns 右侧面板节点
 */
function renderPane(ctrl: AppController, s: AppState): ReactElement {
  switch (s.activePane) {
    case 'activity':
      return React.createElement(ActivityTab, {
        events: s.events,
        toolResults: s.toolResults,
        busy: s.busy,
        activeTool: s.activeTool,
        approval: s.approval,
        question: s.question,
        onOpenPane: (key: string) => ctrl.setActivePane(key),
      });
    case 'skills':
      return React.createElement(SkillsTab, null);
    case 'automations':
      return React.createElement(AutomationsTab, null);
    case 'metrics':
      return React.createElement(MetricsTab, null);
    case 'changes':
      return React.createElement(ChangesTab, null);
    case 'governance':
      // (F2 治理台) 晋升台账逐行独立复核 + 回滚锚点；不依赖会话（治理数据按工作区取）。
      return React.createElement(GovernanceTab, null);
    case 'diagnostics':
      // Web 交付：daemon 运行态 + doctor 报告（两个只读入口合成一屏）。
      return React.createElement(DiagnosticsTab, null);
    case 'audit':
      // Web 交付：审计事件（哈希链）+ 只读 trace 自省。
      return React.createElement(AuditTab, null);
    case 'trace':
      return React.createElement(TraceTab, { sessionId: s.currentThreadId });
    case 'permission':
      // Web 交付：参数级权限规则编辑器（写盘走 config.update，服务端严格校验）。
      return React.createElement(PermissionTab, null);
    case 'vault':
      // Web 交付：凭据保险库（只列名字、写入即清空、服务端不提供回读）。
      return React.createElement(VaultTab, null);
    case 'rollback':
      return React.createElement(RollbackTab, {
        sessionId: s.currentThreadId,
        onRolledBack: ctrl.sessions.loadThread,
      });
    // 'settings' 已**不在此处**（2026-10-17）：设置从右栏面板改成独立页面；
    // 2026-10-26 起它与功能面板合并为 components/console/ConsoleView.tsx。
    // 若这里还留着 case，说明有人把设置又塞回了面板列表——那会与控制台形成两个真相。
    case 'plugins':
      return React.createElement(PluginsTab, null);
    case 'graph':
      return React.createElement(GraphTab, {
        graphRuns: s.graphRuns,
        onRunStart: ctrl.graph.onRunStart,
        // 续跑实现只有一处（控制器），面板卡片与状态栏芯片共用。
        onResume: ctrl.graph.resumeRun,
      });
    case 'memory':
      return React.createElement(MemoryTab, { reloadKey: s.memoryReloadKey });
    case 'profiles':
      return React.createElement(ProfilesTab, { reloadKey: s.profilesReloadKey });
    case 'file':
      return React.createElement(FileTab, { fileView: s.fileView });
    case 'detail':
      return React.createElement(DetailTab, { detailEvent: s.detailEvent });
    case 'tools':
    default:
      return React.createElement(ToolsTab, {
        toolItems: ctrl.sessions.getToolItems(),
        onShowTool: ctrl.sessions.onShowTool,
      });
  }
}

/**
 * 当前会话标题：优先自定义标签，未命名会话显示 id 前缀，再退化为空串（中栏头兜底「新会话」）。
 * @param s 当前状态
 * @returns 标题文案
 */
function sessionTitleOf(s: AppState): string {
  const cur = s.sessions.find((x) => x.id === s.currentThreadId);
  if (cur !== undefined && cur.label !== '') return cur.label;
  // 不把裸会话 id 当标题：新会话在第一事件里**提前认领** currentThreadId（见 SessionController）
  // 时它还没进 sessions 列表，直接把 id 顶上会让标题闪一串 UUID；落回空串由中栏兜底「新会话」。
  return '';
}

/** 当前会话服务端有效时长（ms；历史会话/新会话可能没有）。 */
function sessionActiveMsOf(s: AppState): number | undefined {
  return s.sessions.find((x) => x.id === s.currentThreadId)?.activeMs;
}

/**
 * 装配顶层 DOM 树（三栏主体 + 审批弹窗 + 抽屉遮罩 + 命令面板 + toast）。
 * 壳层为截图式三栏：会话侧栏（品牌 / 新会话 / 插件 / 工作区 / 设置）+ 中栏对话 + 右栏代码查看器；
 * 无全局顶栏——品牌在侧栏头，连接状态在侧栏页脚；功能面板与设置收进同一个「工作台控制台」。
 * @param ctrl 根控制器
 * @param s 当前状态
 * @param pane 右侧内容面板节点
 * @param recentLocalUrls 会话里出现过的回环地址（网页标签空态的一键入口）
 * @returns 顶层 DOM 树
 */
function renderBody(
  ctrl: AppController,
  s: AppState,
  pane: ReactElement,
  recentLocalUrls: readonly string[],
  workspacePath: string,
  onWorkspaceResolved: (path: string) => void,
): ReactElement {
  const consoleOpen = s.settingsOpen || s.panelModalOpen;
  const consoleView = React.createElement(ConsoleView, {
    // 设置按钮与「全部面板」按钮共用同一个控制台，只是落点不同。
    open: s.settingsOpen || s.panelModalOpen,
    active: s.settingsOpen ? s.settingsTab : s.activePane,
    onPick: (key: string) => {
      if (isSettingKey(key)) {
        ctrl.layout.closePanels();
        ctrl.settings.open(key);
        return;
      }
      ctrl.settings.close();
      ctrl.setActivePane(key);
    },
    onClose: () => {
      ctrl.settings.close();
      ctrl.layout.closePanels();
    },
    panelContent: React.createElement(
      React.Suspense,
      {
        fallback: React.createElement(
          'div',
          { className: 'pane-loading empty note' },
          t('加载中…'),
        ),
      },
      pane,
    ),
    settings: {
      theme: s.theme,
      themePref: s.themePref,
      onThemePrefChange: (pref: ThemePreference) => ctrl.layout.setThemePref(pref),
      locale: s.locale,
      onLocaleChange: (l: Locale) => ctrl.settings.setLocale(l),
      workspacePath,
      sessionScopeAll: s.sessionsScopeAll,
      onToggleSessionsScope: ctrl.sessions.toggleSessionsScope,
      leftWidth: s.leftWidth,
      rightWidth: s.rightWidth,
      onLeftWidthChange: ctrl.layout.onLeftWidthChange,
      onRightWidthChange: ctrl.layout.onRightWidthChange,
    },
    workspacePath,
    connected: s.connected,
    streamState: s.streamState,
  });

  return React.createElement(
    'div',
    { className: 'app' },
    React.createElement(
      'div',
      {
        className:
          'body' +
          (s.rightCollapsed ? ' rcollapsed' : '') +
          (consoleOpen ? ' console-open' : ''),
      },
      React.createElement(SessionPanel, {
        sessions: s.sessions,
        currentThreadId: s.currentThreadId,
        onSelect: ctrl.sessions.loadThread,
        onNew: ctrl.sessions.newSession,
        onOpenFile: ctrl.files.openFile,
        onRename: ctrl.sessions.renameSession,
        onDelete: ctrl.sessions.deleteSession,
        onFork: ctrl.sessions.forkSession,
        onArchive: ctrl.sessions.archiveSession,
        onReorder: ctrl.sessions.reorderSessions,
        onWorkspaceSwitched: () => ctrl.sessions.onWorkspaceSwitched(),
        onWorkspaceResolved,
        scopeAll: s.sessionsScopeAll,
        onToggleScope: () => ctrl.sessions.toggleSessionsScope(),
        activePane: s.activePane,
        onOpenPane: (key: string) => ctrl.setActivePane(key),
        // 设置固定在左栏页脚（2026-10-17）：它打开工作台控制台，不再从面板列表进入。
        onOpenSettings: () => {
          ctrl.layout.closePanels();
          ctrl.settings.open();
        },
        connected: s.connected,
        streamState: s.streamState,
        open: s.leftOpen,
        style: { width: s.leftWidth + 'px' },
      }),
      React.createElement(Resizer, {
        side: 'left',
        width: s.leftWidth,
        onChange: (w: number) => ctrl.layout.onLeftWidthChange(w),
      }),
      consoleOpen
        ? React.createElement('div', { className: 'col center console-host' }, consoleView)
        : React.createElement(
            React.Fragment,
            null,
            React.createElement(StreamView, {
              events: s.events,
              historyHasMore: s.historyHasMore,
              historyLoading: s.historyLoading,
              onLoadEarlier: ctrl.sessions.loadEarlier,
              toolResults: s.toolResults,
              liveInputs: s.liveInputs,
              streamText: s.streamText,
              finalizedStreamText: s.finalizedStreamText,
              composerSeed: s.composerSeed,
              onEventClick: ctrl.sessions.showDetail,
              onOpenFile: ctrl.files.openFile,
              // 助手消息里的回环 URL（dev server 地址）可一键进右栏网页标签。
              onOpenUrl: ctrl.browser.open,
              onSend: ctrl.composer.send,
              busy: s.busy,
              activeTool: s.activeTool,
              question: s.question,
              onAnswerQuestion: ctrl.answerQuestion,
              onQuestionExpired: ctrl.expireQuestion,
              onStop: ctrl.composer.stop,
              onRegenerate: ctrl.composer.regenerate,
              onEditUser: ctrl.composer.editLastUser,
              model: s.model,
              modelOptions: s.modelOptions,
              providerLabel: s.providerLabel,
              reasoning: s.reasoning,
              reasoningOptions: s.reasoningOptions,
              permission: s.permission,
              threadId: s.currentThreadId,
              onToast: ctrl.showToast,
              // 编排未跑完时状态栏出现一键续跑（与「编排」面板卡片共用 ctrl.graph.resumeRun）——
              // 用户不必先学会「全部面板 → 编排」的导航才知道有东西没跑完。
              graphRuns: s.graphRuns,
              onGraphResume: ctrl.graph.resumeRun,
              onApplyMode: (patch: { goal?: string; planMode?: boolean; sketchMode?: boolean }) =>
                ctrl.sessions.applyModes(patch),
              onOpenTab: ctrl.openPane,
              onLoadThread: ctrl.sessions.loadThread,
              // 空态「快速开始」示例 → 填进输入框（**不是**直接发送：示例是给人改的模板，
              // 且直接发送会立刻消耗真实额度）。实现与「编辑重发」共用同一条回填通道。
              onUseStarter: ctrl.composer.seedDraft,
              onModelChange: ctrl.composer.changeModel,
              onReasoningChange: ctrl.composer.changeReasoning,
              onPermissionChange: ctrl.composer.changePermission,
              api: ctrl.api,
              sessionTitle: sessionTitleOf(s),
              workspacePath,
              sessionActiveMs: sessionActiveMsOf(s),
              streamState: s.streamState,
              adapter: s.adapter,
              onToggleLeft: () => ctrl.layout.toggleLeft(),
              onToggleRight: () => ctrl.layout.toggleRight(),
              rightCollapsed: s.rightCollapsed,
            }),
            React.createElement(Resizer, {
              side: 'right',
              width: s.rightWidth,
              onChange: (w: number) => ctrl.layout.onRightWidthChange(w),
            }),
            React.createElement(
              RightPanel,
              {
                open: s.rightOpen,
                openFiles: s.openFiles,
                activeFileTitle: s.fileView?.title ?? null,
                onShowFile: ctrl.files.showOpenFile,
                onCloseFile: ctrl.files.closeOpenFile,
                style: { width: s.rightWidth + 'px' },
                // 右栏网页标签（2026-10-19）：地址 / 重载 / 关闭全部由 BrowserController 收口。
                browser: s.browser,
                onOpenBrowser: ctrl.browser.show,
                onShowBrowser: ctrl.browser.show,
                onCloseBrowser: ctrl.browser.close,
                onPreviewFile: ctrl.browser.previewFile,
                browserContent: React.createElement(BrowserPane, {
                  view: s.browser,
                  recentUrls: recentLocalUrls,
                  onNavigate: ctrl.browser.open,
                  onReload: ctrl.browser.reload,
                }),
              },
              // 右栏文件视图；功能面板与设置在下面的控制台（ConsoleView）里。
              React.createElement(FileTab, { fileView: s.fileView }),
            ),
          ),
    ),
    React.createElement(ApprovalModal, {
      approval: s.approval,
      onRespond: ctrl.respondApproval,
      // 「修改权限」直接打开控制台的权限页（原实现打开的是一个已不存在的面板 key）。
      onChangePermission: ctrl.settings.openPermission,
    }),
    React.createElement('div', {
      className: 'drawer-backdrop' + (s.leftOpen || s.rightOpen ? ' show' : ''),
      onClick: ctrl.sessions.closeDrawers,
    }),
    React.createElement(CommandPalette, {
      open: s.paletteOpen,
      commands: ctrl.commands,
      onClose: ctrl.closePalette,
    }),
    React.createElement(Toast, { toast: s.toastState }),
    React.createElement(DialogHost, { dialog: s.dialog }),
  );
}

/**
 * 应用根组件：消费容器控制器 AppController 的全部状态与回调，装配三栏布局树。
 * @returns 根渲染树（含 AppContext.Provider）
 */
export function App(): ReactElement {
  const [state, setState] = React.useState<AppState>(initialState);
  // 最新状态镜像：供控制器同步读取（getState），避免闭包读到陈旧快照。
  const stateRef = React.useRef<AppState>(state);
  stateRef.current = state;
  // 当前项目路径只服务中栏面包屑，放在视图层局部状态：不必进 AppController 的上帝类。
  const [workspacePath, setWorkspacePath] = React.useState('');

  // 组合根：控制器只构造一次；host 桥接到稳定 setState + 最新状态 ref。
  const controllerRef = React.useRef<AppController | null>(null);
  if (controllerRef.current === null) {
    const host: AppHost = {
      patch: (action: AppAction) => setState((prev) => mergeAppPatch(prev, action)),
      getState: () => stateRef.current,
    };
    controllerRef.current = new AppController(host);
  }
  const controller = controllerRef.current;

  // 挂载后启动控制器（连接 SSE / 拉取配置 / 恢复主题），卸载前清理（原 componentDidMount/WillUnmount）。
  React.useEffect(() => {
    controller.mount();
    return () => {
      controller.unmount();
    };
  }, [controller]);

  // 空闲期预取按需面板（2026-10-18）：不阻塞首屏；预取完成后首次点开面板零等待。
  // 用 requestIdleCallback（带 2s 上限）而不是立即执行：首屏的 SSE/配置请求优先。
  React.useEffect(() => {
    const idle = window.requestIdleCallback;
    if (typeof idle === 'function') {
      const id = idle(() => prefetchLazyPanes(), { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(prefetchLazyPanes, 800);
    return () => window.clearTimeout(timer);
  }, []);

  // 会话里出现过的本地开发地址（dev server / 预览链接）：给网页标签空态做一键入口。
  // 只扫最近若干条（倒序），不在每帧对全量事件做正则——长会话里那是可见的卡顿源。
  const recentLocalUrls = React.useMemo(() => {
    const texts: string[] = [];
    for (let i = state.events.length - 1; i >= 0 && texts.length < 24; i -= 1) {
      const ev = state.events[i];
      if (ev !== undefined && ev.type === 'assistant') {
        texts.push(String(ev.payload?.content ?? ''));
      }
    }
    const results = Object.values(state.toolResults);
    for (let i = results.length - 1; i >= 0 && texts.length < 36; i -= 1) {
      texts.push(results[i]?.text ?? '');
    }
    return LocalDevUrls.collect(texts, {
      limit: 6,
      excludeHostPort: typeof location === 'undefined' ? '' : location.host,
    });
  }, [state.events, state.toolResults]);

  const pane = renderPane(controller, state);
  return React.createElement(
    AppContext.Provider,
    { value: controller.getContextValue() },
    // W1：整棵视图树包进 ThemeProvider（antd 主题/locale/message 上下文）。
    // 2026-10-29 合并：全站悬浮提示层也在主题内——它是 position:fixed 的覆盖层，
    // 与 `.app` 平级、不参与三栏布局（不塞进 renderBody，那里函数体有冻结基线）。
    React.createElement(ThemeProvider, {
      theme: state.theme,
      children: React.createElement(
        React.Fragment,
        null,
        React.createElement(TooltipLayer, null),
        renderBody(controller, state, pane, recentLocalUrls, workspacePath, setWorkspacePath),
      ),
    }),
  );
}

/**
 * 在容器元素上挂载应用（由 main.ts 调用，便于独立测试）。
 * @param container 挂载容器元素
 * @returns 无
 */
export function mountApp(container: Element): void {
  // 最外层套**渲染错误边界**：渲染期抛错若无人接管，React 会卸载整棵树 ⇒ 用户看到全黑空白页
  // （2026-09-27 两次报障即此形态）。有边界则降级为可读错误面板 + 原地重试，并留存现场。
  // 层次：StrictMode（最外）→ RenderErrorBoundary → App。
  //
  // 为什么套 **StrictMode**（标准 Vite React 模板的默认形态，2026-10-17 补）：
  //   它在**开发**态故意让状态更新函数与 effect 跑两遍，从而暴露三类只有并发渲染才会犯的错——
  //   副作用没清理、effect 依赖写漏、在渲染期做副作用。这些错误在生产态表现为偶发的
  //   "数据重复加载 / 监听器泄漏"，极难复现；开着 StrictMode 时一写就露。
  //   生产构建里它是**空操作**（不双跑），故不影响线上行为与包体积（gzip 后 < 10 字节）。
  //
  // 为什么放在**错误边界外面**：边界若自己抛错，StrictMode 不接错误，不该被当成兜底手段；
  //   而边界放里层才能既接住 App 的错、又让自己处在双跑检验之外（边界本不该有副作用）。
  createRoot(container).render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(RenderErrorBoundary, null, React.createElement(App, null)),
    ),
  );
}
