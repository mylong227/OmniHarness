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

import { TopBar } from './components/TopBar.js';
import { SessionPanel } from './components/SessionPanel.js';
import { StreamView } from './components/StreamView.js';
import { RightPanel } from './components/RightPanel.js';
import { NavRail } from './components/NavRail.js';
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

/** AppHost.patch 的入参形态（局部补丁 / 函数式 updater）。 */
type AppAction = Partial<AppState> | ((prev: AppState) => Partial<AppState>);

/** 根状态初值（与拆分前的 class 构造函数逐字一致）。 */
function initialState(): AppState {
  return {
    connected: false,
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
    fileView: null,
    theme: 'dark',
    leftOpen: false,
    rightOpen: false,
    memoryReloadKey: 0,
    profilesReloadKey: 0,
    graphRuns: {},
    busy: false,
    activeTool: null,
    toastState: { message: '', kind: 'info', visible: false },
    paletteOpen: false,
    dialog: { request: null },
    streamText: '',
    finalizedStreamText: '',
    composerSeed: null,
    leftWidth: 248,
    rightWidth: 360,
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
    case 'rollback':
      return React.createElement(RollbackTab, { sessionId: s.currentThreadId, onRolledBack: ctrl.sessions.loadThread });
    case 'settings':
      return React.createElement(SettingsTab, { theme: s.theme, onToggleTheme: () => ctrl.layout.toggleTheme() });
    case 'plugins':
      return React.createElement(PluginsTab, null);
    case 'graph':
      return React.createElement(GraphTab, { graphRuns: s.graphRuns, onRunStart: ctrl.graph.onRunStart });
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
 * 装配顶层 DOM 树（顶栏 + 三栏主体 + 审批弹窗 + 抽屉遮罩 + 命令面板 + toast）。
 * @param ctrl 根控制器
 * @param s 当前状态
 * @param pane 右侧内容面板节点
 * @returns 顶层 DOM 树
 */
function renderBody(ctrl: AppController, s: AppState, pane: ReactElement): ReactElement {
  return React.createElement(
    'div',
    { className: 'app' },
    React.createElement(TopBar, {
      connected: s.connected,
      adapter: s.adapter,
      onToggleTheme: () => ctrl.layout.toggleTheme(),
      onToggleLeft: () => ctrl.layout.toggleLeft(),
      onToggleRight: () => ctrl.layout.toggleRight(),
      onCommandPalette: ctrl.openPalette,
    }),
    React.createElement(
      'div',
      { className: 'body' },
      React.createElement(NavRail, { activePane: s.activePane, onSelect: ctrl.setActivePane }),
      React.createElement(SessionPanel, {
        sessions: s.sessions,
        currentThreadId: s.currentThreadId,
        onSelect: ctrl.sessions.loadThread,
        onNew: ctrl.sessions.newSession,
        onOpenFile: ctrl.sessions.openFile,
        onRename: ctrl.sessions.renameSession,
        onDelete: ctrl.sessions.deleteSession,
        onFork: ctrl.sessions.forkSession,
        onWorkspaceSwitched: () => ctrl.sessions.refreshSessions(),
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
        onOpenFile: ctrl.sessions.openFile,
        onSend: ctrl.composer.send,
        busy: s.busy,
        activeTool: s.activeTool,
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
        onOpenTab: ctrl.openPane,
        onLoadThread: ctrl.sessions.loadThread,
        onModelChange: ctrl.composer.changeModel,
        onReasoningChange: ctrl.composer.changeReasoning,
        onPermissionChange: ctrl.composer.changePermission,
        api: ctrl.api,
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
  ReactDOM.createRoot(container).render(React.createElement(App, null));
}
