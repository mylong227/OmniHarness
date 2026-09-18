// 应用根组件：纯视图层（C3 拆分后的标准 class 方式）。
// 状态与副作用全部上移到 AppController（组合根 / 门面）+ 子控制器（Session / Composer / Graph），
// 本类只负责「状态 → DOM 树」的装配，不含任何直接 setState / 副作用 / 内联箭头回调
// （回调统一经 this.controller.* 命名引用，this.state 即唯一数据源）。

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

/** React.Component.setState 的首参类型（用于把 Partial 补丁桥接进去）。 */
type ReactSetStateArg = Parameters<typeof React.Component.prototype.setState>[0];

/** 应用根组件：消费容器控制器 AppController 的全部状态与回调，装配三栏布局树。 */
export class App extends React.Component<Record<string, never>, AppState> implements AppHost {
  /** 根状态容器控制器（组合根 / 门面）。 */
  private readonly controller: AppController;

  /** 初始化状态并组合控制器（组合根）。 */
  public constructor() {
    super({});
    this.state = {
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
      leftWidth: 248,
      rightWidth: 360,
    };
    this.controller = new AppController(this);
  }

  /** 挂载后启动控制器（连接 SSE / 拉取配置 / 恢复主题等）。 @returns 无 */
  public componentDidMount(): void {
    this.controller.mount();
  }

  /** 卸载前清理控制器（关闭 SSE / 移除监听）。 @returns 无 */
  public componentWillUnmount(): void {
    this.controller.unmount();
  }

  /**
   * 以局部补丁或函数式 updater 更新状态（AppHost 契约）。
   * @param state 状态补丁或函数式 updater
   * @returns 无
   */
  public patch(state: Partial<AppState> | ((prev: AppState) => Partial<AppState>)): void {
    this.setState(state as unknown as ReactSetStateArg);
  }

  /** 读取当前完整状态（AppHost 契约）。 @returns 当前状态 */
  public getState(): AppState {
    return this.state;
  }

  /**
   * 在 #root 上挂载应用（由 main.ts 调用，便于独立测试）。
   * @param container 挂载容器元素
   * @returns 无
   */
  public static mount(container: Element): void {
    ReactDOM.createRoot(container).render(React.createElement(App, null));
  }

  /** 渲染：包装 AppContext.Provider 并装配三栏布局。 @returns 渲染树 */
  public render(): ReactElement {
    const pane = this.renderPane();
    return React.createElement(
      AppContext.Provider,
      { value: this.controller.getContextValue() },
      this.renderBody(pane),
    );
  }

  /** 按当前激活面板选择右侧内容面板。 @returns 右侧面板节点 */
  private renderPane(): ReactElement {
    const ctrl = this.controller;
    const s = this.state;
    switch (s.activePane) {
      case 'metrics':
        return React.createElement(MetricsTab, null);
      case 'changes':
        return React.createElement(ChangesTab, null);
      case 'rollback':
        return React.createElement(RollbackTab, { sessionId: s.currentThreadId, onRolledBack: ctrl.sessions.loadThread });
      case 'settings':
        return React.createElement(SettingsTab, { theme: s.theme, onToggleTheme: ctrl.toggleTheme });
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
        return React.createElement(ToolsTab, { toolItems: ctrl.sessions.getToolItems(), onShowTool: ctrl.sessions.onShowTool });
    }
  }

  /**
   * 装配顶层 DOM 树（顶栏 + 三栏主体 + 审批弹窗 + 抽屉遮罩 + 命令面板 + toast）。
   * @param pane 右侧内容面板节点
   * @returns 顶层 DOM 树
   */
  private renderBody(pane: ReactElement): ReactElement {
    const ctrl = this.controller;
    const s = this.state;
    return React.createElement(
      'div',
      { className: 'app' },
      React.createElement(TopBar, {
        connected: s.connected,
        adapter: s.adapter,
        onToggleTheme: ctrl.toggleTheme,
        onToggleLeft: ctrl.toggleLeft,
        onToggleRight: ctrl.toggleRight,
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
        React.createElement(Resizer, { side: 'left', width: s.leftWidth, onChange: ctrl.onLeftWidthChange }),
        React.createElement(StreamView, {
          events: s.events,
          toolResults: s.toolResults,
          liveInputs: s.liveInputs,
          streamText: s.streamText,
          finalizedStreamText: s.finalizedStreamText,
          onEventClick: ctrl.sessions.showDetail,
          onOpenFile: ctrl.sessions.openFile,
          onSend: ctrl.composer.send,
          busy: s.busy,
          activeTool: s.activeTool,
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
        React.createElement(Resizer, { side: 'right', width: s.rightWidth, onChange: ctrl.onRightWidthChange }),
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
}
