/**
 * 桌面配置公共入口：类型 + 默认值 + 加载器 + CSP 格式化。
 *
 * 保持既有 `import { loadDesktopConfig } from './config.ts'` 路径不变；
 * 具体实现按职责拆在 `config/` 子目录（单文件单类）。
 */
export type {
  DesktopAppConfig,
  DesktopConfig,
  DesktopCspConfig,
  DesktopDeepLinkConfig,
  DesktopHarnessConfig,
  DesktopIpcConfig,
  DesktopLoggingConfig,
  DesktopNotificationConfig,
  DesktopSecurityConfig,
  DesktopStateConfig,
  DesktopTrayConfig,
  DesktopUpdateConfig,
  DesktopWindowConfig,
  LoadDesktopConfigOptions,
  LoadedDesktopConfig,
} from './config/types.ts';
export { DEFAULT_DESKTOP_CONFIG } from './config/defaults.ts';
export { DesktopConfigLoader } from './config/DesktopConfigLoader.ts';
export { CspFormatter } from './config/formatCsp.ts';

import { DesktopConfigLoader } from './config/DesktopConfigLoader.ts';
import { CspFormatter } from './config/formatCsp.ts';
import type {
  DesktopCspConfig,
  LoadDesktopConfigOptions,
  LoadedDesktopConfig,
} from './config/types.ts';

/**
 * 加载桌面配置（兼容既有函数式调用）。
 * @param options 三份文件路径。
 * @returns 生效配置、告警与来源。
 */
export const loadDesktopConfig = (options: LoadDesktopConfigOptions = {}): LoadedDesktopConfig =>
  DesktopConfigLoader.load(options);

/**
 * 格式化 CSP（兼容既有函数式调用）。
 * @param csp 指令表。
 * @returns CSP 响应头值。
 */
export const formatCsp = (csp: DesktopCspConfig): string => CspFormatter.format(csp);
