// 应用上下文：把核心服务（ApiClient / ToastService）通过 React Context 注入组件树，
// 各 Tab 与面板通过 useApp() 取用，避免逐层透传 props。

import { React } from './deps.js';
import type { ApiClient } from '../core/ApiClient.js';
import type { ToastKind } from '../core/ToastService.js';

export interface AppContextValue {
  api: ApiClient;
  toast: (message: string, kind?: ToastKind) => void;
  /** 重新拉取厂商目录（model.catalog）：检测/启用厂商后调用，Composer 模型下拉即时反映真实可用清单。 */
  refreshModelCatalog?: () => void;
}

export const AppContext = React.createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppContext.Provider 内使用');
  return ctx;
}
