// 应用根组件：纯视图层（C3 拆分后的标准写法）。
// 状态与副作用全部上移到 AppController（组合根 / 门面）+ 子控制器（Session / Composer / Graph），
// 本组件只负责「状态 → DOM 树」的装配，不含任何业务副作用
// （回调统一经 controller.* 命名引用，App 状态即唯一数据源）。
//
// 函数组件范式：根状态用 useState（惰性初始化）+ 函数式 updater 承接 AppHost.patch；
// 控制器只构造一次（useRef 惰性初始化），host 桥接到「稳定的 setState + 最新状态 ref」，
// 故 patch 永不读到陈旧快照（H5）；挂载启动 / 卸载清理由依赖 [controller] 的 effect 承接。

import { React, ReactDOM } from './deps.js';
import { AppContext } from './context.js';
import { AppController } from './controllers/AppController.js';
import type { AppHost, AppState } from './controllers/AppController.js';

import { RenderErrorBoundary } from './components/RenderErrorBoundary.js';
import { SessionPanel } from './components/SessionPanel.js';
import { StreamView } from './components/StreamView.js';
import { RightPanel } from './components/RightPanel.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Toast } from './components/Toast.js';
import { DialogHost } from './components/DialogHost.js';
import { Resizer } from './components/Resizer.js';

import { ToolsTab } from './components/tabs/ToolsTab.js';
import { MetricsTab } from './components/tabs/MetricsTab.js';
import { ChangesTab } from './components/tabs/ChangesTab.js';
import { SettingsTab } from './components/tabs/SettingsTab.js';
import { PluginsTab } from './components/tabs/PluginsTab.js';
import { GraphTab } from './components/tabs/GraphTab.js';
import { MemoryTab } from './components/tabs/MemoryTab.js';
import { ProfilesTab } from './components/tabs/ProfilesTab.js';
import { FileTab } from './components/tabs/FileTab.js';
import { DetailTab } from './components/tabs/DetailTab.js';
import { RollbackTab } from './components/tabs/RollbackTab.js';
import { GovernanceTab } from './components/tabs/GovernanceTab.js';
import { SessionsScope } from './models/SessionsScope.js';

/** AppHost.patch 的入参形态（局部补丁 / 函数式 updater）。 */
type AppAction = Partial<AppState> | ((prev: AppState) => Partial<AppState>);

/** 根状态初值（与拆分前的 class 构造函数逐字一致）。 */
function initialState(): AppState {
  return {
    connected: false,
    // 首屏是「连接中」而不是「断开」：还没连上就报红色断开是假故障（徽标文案见 SidebarFooter）。
    streamState: 'connecting',
    adapter: '',
    activePane: 'tools',
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
    detailEvent: null,
    approval: null,
    question: null,
    fileView: null,
    openFiles: [],
    theme: 'dark',
    leftOpen: false,
    rightOpen: false,
    // 桌面右栏收起态的本机偏好在 LayoutController.initTheme 里恢复；首屏先展开。
    rightCollapsed: false,
    memoryReloadKey: 0,
    profilesReloadKey: 0,
    graphRuns: {},
    busy: false,
    activeTool: null,
    toastState: { message: '', kind: 'info', visible: false },
    paletteOpen: false,
    sessionsScopeAll: SessionsScope.read() === 'all',
    dialog: { request: null },
    streamText: '',
    finalizedStreamText: '',
    composerSeed: null,
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
    case 'metrics':
      return React.createElement(MetricsTab, null);
    case 'changes':
      return React.createElement(ChangesTab, null);
    case 'governance':
      // (F2 治理台) 晋升台账逐行独立复核 + 回滚锚点；不依赖会话（治理数据按工作区取）。
      return React.createElement(GovernanceTab, null);
    case 'rollback':
      return React.createElement(RollbackTab, { sessionId: s.currentThreadId, onRolledBack: ctrl.sessions.loadThread });
    case 'settings':
      return React.createElement(SettingsTab, { theme: s.theme, onToggleTheme: () => ctrl.layout.toggleTheme() });
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
  return s.currentThreadId === null ? '' : s.currentThreadId;
}

/**
 * 装配顶层 DOM 树（三栏主体 + 审批弹窗 + 抽屉遮罩 + 命令面板 + toast）。
 * 壳层为截图式三栏：会话侧栏（品牌 / 新会话 / 插件 / 工作区 / 设置）+ 中栏对话 + 右栏代码查看器；
 * 无全局顶栏——品牌在侧栏头，连接状态在侧栏页脚，12 个功能面板收进右栏的「全部面板」菜单。
 * @param ctrl 根控制器
 * @param s 当前状态
 * @param pane 右侧内容面板节点
 * @returns 顶层 DOM 树
 */
function renderBody(ctrl: AppController, s: AppState, pane: ReactElement): ReactElement {
  return React.createElement(
    'div',
    { className: 'app' },
    React.createElement(
      'div',
      { className: 'body' + (s.rightCollapsed ? ' rcollapsed' : '') },
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
        scopeAll: s.sessionsScopeAll,
        onToggleScope: () => ctrl.sessions.toggleSessionsScope(),
        activePane: s.activePane,
        onOpenPane: (key: string) => ctrl.setActivePane(key),
        onOpenPalette: () => ctrl.openPalette(),
        connected: s.connected,
        streamState: s.streamState,
        theme: s.theme,
        onToggleTheme: () => ctrl.layout.toggleTheme(),
        open: s.leftOpen,
        style: { width: s.leftWidth + 'px' },
      }),
      React.createElement(Resizer, {
        side: 'left',
        width: s.leftWidth,
        onChange: (w: number) => ctrl.layout.onLeftWidthChange(w),
      }),
      React.createElement(StreamView, {
        events: s.events,
        toolResults: s.toolResults,
        liveInputs: s.liveInputs,
        streamText: s.streamText,
        finalizedStreamText: s.finalizedStreamText,
        composerSeed: s.composerSeed,
        onEventClick: ctrl.sessions.showDetail,
        onOpenFile: ctrl.files.openFile,
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
          activePane: s.activePane,
          onSelect: ctrl.setActivePane,
          open: s.rightOpen,
          openFiles: s.openFiles,
          activeFileTitle: s.fileView?.title ?? null,
          onShowFile: ctrl.files.showOpenFile,
          onCloseFile: ctrl.files.closeOpenFile,
          onCollapse: () => ctrl.layout.toggleRight(),
          style: { width: s.rightWidth + 'px' },
        },
        pane,
      ),
    ),
    React.createElement(ApprovalModal, {
      approval: s.approval,
      onRespond: ctrl.respondApproval,
      onChangePermission: ctrl.openSettingsPane,
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

  const pane = renderPane(controller, state);
  return React.createElement(
    AppContext.Provider,
    { value: controller.getContextValue() },
    renderBody(controller, state, pane),
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
  ReactDOM.createRoot(container).render(
    React.createElement(RenderErrorBoundary, null, React.createElement(App, null)),
  );
}

