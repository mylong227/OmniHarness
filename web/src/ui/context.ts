// 应用上下文：把核心服务（ApiClient / ToastService）通过 React Context 注入组件树，
// 各 Tab 与面板通过 useApp() 取用，避免逐层透传 props。

import * as React from 'react';
import type { ApiClient } from '../core/ApiClient.ts';
import type { ToastKind } from '../core/ToastService.ts';
import type { DialogService } from '../core/DialogService.ts';
import { t } from './i18n/i18n.ts';

export interface AppContextValue {
  api: ApiClient;
  toast: (message: string, kind?: ToastKind) => void;
  /** 应用内对话框服务（确认 / 输入），替代 window.confirm / window.prompt。 */
  dialog: DialogService;
  /** 重新拉取厂商目录（model.catalog）：检测/启用厂商后调用，Composer 模型下拉即时反映真实可用清单。 */
  refreshModelCatalog?: () => void;
  /** 当前会话 id（null = 尚未创建会话 / 新会话态）。 */
  sessionId: string | null;
  /** 会话数据版本号：切换会话或回合推进后 +1，面板据此重新拉取自己的数据。 */
  sessionTick: number;
  /**
   * 工作区切换代数：**当前项目真的变了**才 +1（打开别家项目的会话会隐式切项目）。
   *
   * 为什么不能复用 `sessionTick`：它随每个语义事件都变，拿它重取项目清单等于每回合打一串
   * `workspace.list`；而"项目身份变了"是一个稀疏、可精确标记的事实（2026-10-28 审计：
   * 打开别家项目的会话后，侧栏项目名 / 面包屑 / 文件树仍停在旧项目）。
   */
  workspaceEpoch?: number;
}

export const AppContext = React.createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error(t('useApp 必须在 AppContext.Provider 内使用'));
  return ctx;
}
