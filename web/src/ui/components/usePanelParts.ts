// App 渲染期的稳定产物收口（2026-11-01 前端性能批）。
//
// 为什么要有这个 hook：App 每帧重渲染（每条 SSE 事件 patch 一次），过去回调束 / 左栏样式 /
// 上下文值都是**每帧新建**——memo 化的 SessionPanel 浅比较恒不等（形同虚设），24 个 useApp()
// 消费者随每条事件全量重渲染。这里把三份产物收拢成 useMemo：
//   · panelHandlers / leftStyle：依赖只有稳定的 controller / ref / 宽度数字，挂载期身份不变；
//   · contextValue：按**稀疏字段** memo——api/toast/dialog 服务全程稳定，sessionId/sessionTick/
//     workspaceEpoch 只在真变化时换身份（sessionTick 的回合级刷新语义保持不变）。
// 判据：web/test/sessionPanelMemo.test.ts（memo 生效 / 不过度 memo / context 照常到达）。

import * as React from 'react';
import type { AppController, AppState } from '../controllers/AppController.ts';
import type { AppContextValue } from '../context.ts';

/** 会话面板稳定回调束的形状（makePanelHandlers 的产物，挂载期内身份不变）。 */
export interface PanelHandlers {
  /** 打开会话。 */
  onSelect: (id: string) => void;
  /** 显式切换工作区后同步界面。 */
  onWorkspaceSwitched: () => void;
  /** 打开面板。 */
  onOpenPane: (key: string) => void;
  /** 切换会话范围（当前项目 / 全部）。 */
  onToggleScope: () => void;
  /** 打开设置（工作台控制台）。 */
  onOpenSettings: () => void;
}

/**
 * 构造会话面板的稳定回调束。
 * @param ctrl 应用控制器
 * @param consoleOpenerRef 设置入口焦点来源记录（打开控制台前记下触发按钮）
 * @param openThreadId 打开会话（App.ts 的 openThread 闭包，调用方用 useMemo 固定身份）
 * @returns 稳定回调束
 */
const makePanelHandlers = (
  ctrl: AppController,
  consoleOpenerRef: React.RefObject<HTMLElement | null>,
  openThreadId: (id: string) => void,
): PanelHandlers => ({
  onSelect: openThreadId,
  onWorkspaceSwitched: () => ctrl.sessions.onWorkspaceSwitched(),
  onOpenPane: (key: string) => ctrl.setActivePane(key),
  onToggleScope: () => ctrl.sessions.toggleSessionsScope(),
  onOpenSettings: () => {
    // 先记下打开瞬间的焦点（触发按钮），再收抽屉——抽屉一收，visibility:hidden
    // 会立即使触发器失焦，lazy 的 ConsoleView 挂载时已无法从 activeElement 恢复它。
    consoleOpenerRef.current = document.activeElement as HTMLElement | null;
    ctrl.layout.closePanels();
    ctrl.settings.open();
  },
});

/** usePanelParts 的产物（传给 renderBody / AppContext.Provider）。 */
export interface PanelParts {
  /** 会话面板稳定回调束。 */
  readonly panelHandlers: PanelHandlers;
  /** 左栏宽度样式（稳定身份）。 */
  readonly leftStyle: Record<string, string>;
  /** AppContext 值（稀疏字段 memo）。 */
  readonly contextValue: AppContextValue;
}

/**
 * App 渲染期的三份稳定产物（见文件头说明）。
 * @param controller 应用控制器
 * @param consoleOpenerRef 设置入口焦点来源记录
 * @param state 应用状态（只读其稀疏字段与 leftWidth）
 * @param openThreadId 打开会话回调（身份必须稳定，见 makePanelHandlers）
 * @returns panelHandlers / leftStyle / contextValue
 */
export function usePanelParts(
  controller: AppController,
  consoleOpenerRef: React.RefObject<HTMLElement | null>,
  state: AppState,
  openThreadId: (id: string) => void,
): PanelParts {
  const panelHandlers = React.useMemo(
    () => makePanelHandlers(controller, consoleOpenerRef, openThreadId),
    [controller, consoleOpenerRef, openThreadId],
  );
  const leftStyle = React.useMemo<Record<string, string>>(
    () => ({ width: state.leftWidth + 'px' }),
    [state.leftWidth],
  );
  const contextValue = React.useMemo(
    () => controller.getContextValue(),
    [controller, state.currentThreadId, state.sessionTick, state.workspaceEpoch],
  );
  return { panelHandlers, leftStyle, contextValue };
}
