// 应用根组件：纯视图层（C3 拆分后）。
// 状态与副作用全部上移到 useAppController（容器 hook），本文件只负责「状态 → DOM 树」的装配，
// 不含任何 useState/useEffect/useCallback 与内联箭头回调（回调统一经 ctrl.* 命名引用）。

import { React, ReactDOM } from './deps.js';
import { AppContext } from './context.js';
import { useAppController } from './useAppController.js';

import { TopBar } from './components/TopBar.js';
import { SessionPanel } from './components/SessionPanel.js';
import { StreamView } from './components/StreamView.js';
import { RightPanel } from './components/RightPanel.js';
import { NavRail } from './components/NavRail.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Toast } from './components/Toast.js';
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

/** 应用根组件：消费容器 hook 的全部状态与回调，装配三栏布局树。 */
export function App(): ReactElement {
  const ctrl = useAppController();

  let pane: ReactElement;
  switch (ctrl.activePane) {
    case 'metrics':
      pane = React.createElement(MetricsTab, null);
      break;
    case 'changes':
      pane = React.createElement(ChangesTab, null);
      break;
    case 'rollback':
      pane = React.createElement(RollbackTab, { sessionId: ctrl.currentThreadId, onRolledBack: ctrl.loadThread });
      break;
    case 'settings':
      pane = React.createElement(SettingsTab, { theme: ctrl.theme, onToggleTheme: ctrl.toggleTheme });
      break;
    case 'plugins':
      pane = React.createElement(PluginsTab, null);
      break;
    case 'graph':
      pane = React.createElement(GraphTab, { graphRuns: ctrl.graphRuns, onRunStart: ctrl.onRunStart });
      break;
    case 'memory':
      pane = React.createElement(MemoryTab, { reloadKey: ctrl.memoryReloadKey });
      break;
    case 'profiles':
      pane = React.createElement(ProfilesTab, { reloadKey: ctrl.profilesReloadKey });
      break;
    case 'file':
      pane = React.createElement(FileTab, { fileView: ctrl.fileView });
      break;
    case 'detail':
      pane = React.createElement(DetailTab, { detailEvent: ctrl.detailEvent });
      break;
    case 'tools':
    default:
      pane = React.createElement(ToolsTab, { toolItems: ctrl.toolItems, onShowTool: ctrl.onShowTool });
      break;
  }

  return React.createElement(
    AppContext.Provider,
    { value: ctrl.ctxValue },
    React.createElement(
      'div',
      { className: 'app' },
      React.createElement(TopBar, {
        connected: ctrl.connected,
        adapter: ctrl.adapter,
        onToggleTheme: ctrl.toggleTheme,
        onToggleLeft: ctrl.toggleLeft,
        onToggleRight: ctrl.toggleRight,
        onCommandPalette: ctrl.openPalette,
      }),
      React.createElement(
        'div',
        { className: 'body' },
        React.createElement(NavRail, { activePane: ctrl.activePane, onSelect: ctrl.setActivePane }),
        React.createElement(SessionPanel, {
          sessions: ctrl.sessions,
          currentThreadId: ctrl.currentThreadId,
          onSelect: ctrl.loadThread,
          onNew: ctrl.newSession,
          onOpenFile: ctrl.openFile,
          onWorkspaceSwitched: ctrl.refreshSessionsVoid,
          open: ctrl.leftOpen,
          style: { width: ctrl.leftWidth + 'px' },
        }),
        React.createElement(Resizer, { side: 'left', width: ctrl.leftWidth, onChange: ctrl.onLeftWidthChange }),
        React.createElement(StreamView, {
          events: ctrl.events,
          toolResults: ctrl.toolResults,
          liveInputs: ctrl.liveInputs,
          onEventClick: ctrl.showDetail,
          onOpenFile: ctrl.openFile,
          onSend: ctrl.send,
          busy: ctrl.busy,
          activeTool: ctrl.activeTool,
          model: ctrl.model,
          modelOptions: ctrl.modelOptions,
          providerLabel: ctrl.providerLabel,
          reasoning: ctrl.reasoning,
          reasoningOptions: ctrl.reasoningOptions,
          permission: ctrl.permission,
          threadId: ctrl.currentThreadId,
          onToast: ctrl.showToast,
          onOpenTab: ctrl.openPane,
          onLoadThread: ctrl.loadThread,
          onModelChange: ctrl.changeModel,
          onReasoningChange: ctrl.changeReasoning,
          onPermissionChange: ctrl.changePermission,
          api: ctrl.api,
        }),
        React.createElement(Resizer, { side: 'right', width: ctrl.rightWidth, onChange: ctrl.onRightWidthChange }),
        React.createElement(
          RightPanel,
          {
            activePane: ctrl.activePane,
            onSelect: ctrl.setActivePane,
            open: ctrl.rightOpen,
            style: { width: ctrl.rightWidth + 'px' },
          },
          pane,
        ),
      ),
      React.createElement(ApprovalModal, {
        approval: ctrl.approval,
        onRespond: ctrl.respondApproval,
        onChangePermission: ctrl.openSettingsPane,
      }),
      React.createElement('div', {
        className: 'drawer-backdrop' + (ctrl.leftOpen || ctrl.rightOpen ? ' show' : ''),
        onClick: ctrl.closeDrawers,
      }),
      React.createElement(CommandPalette, {
        open: ctrl.paletteOpen,
        commands: ctrl.commands,
        onClose: ctrl.closePalette,
      }),
      React.createElement(Toast, { toast: ctrl.toastState }),
    ),
  );
}

// 挂载入口（由 main.ts 调用，便于独立测试）。
export function mountApp(container: Element): void {
  ReactDOM.createRoot(container).render(React.createElement(App, null));
}
