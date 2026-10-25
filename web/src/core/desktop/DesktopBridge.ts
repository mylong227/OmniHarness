/**
 * 桌面宿主桥（浏览器下为 null）。
 *
 * 只做能力检测与轻量封装：UI 不直接读 `window.omni`，也不依赖 Electron。
 * 桌面端 preload 暴露的是最小面；浏览器/测试环境没有 `window.omni` 时全部 no-op。
 */

/** 通知输入（与 desktop preload 对齐）。 */
export interface DesktopNotifyInput {
  /** 标题。 */
  readonly title: string;
  /** 正文。 */
  readonly body: string;
  /** 关联会话 id。 */
  readonly sessionId?: string;
}

/** 桌面信息（设置面板展示）。 */
export interface DesktopInfo {
  /** 应用版本。 */
  readonly appVersion: string;
  /** 平台。 */
  readonly platform: string;
  /** 当前工作区。 */
  readonly workspace: string;
  /** 关闭时最小化到托盘。 */
  readonly closeToTray: boolean;
  /** 开机启动。 */
  readonly openAtLogin: boolean;
}

/** 更新状态（与主进程 UpdateStatus 对齐）。 */
export type DesktopUpdateStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'available'; readonly version: string }
  | { readonly state: 'downloading'; readonly percent: number }
  | { readonly state: 'downloaded'; readonly version: string }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'disabled'; readonly reason: string };

/** 桌面桥最小面（只声明 UI 用到的部分）。 */
export interface DesktopBridge {
  /** 桥版本。 */
  readonly apiVersion: number;
  getInfo(): Promise<DesktopInfo>;
  setCloseToTray(enabled: boolean): Promise<void>;
  setOpenAtLogin(enabled: boolean): Promise<void>;
  openLogs(): Promise<void>;
  restartHarness(): Promise<void>;
  /** 在系统文件管理器中打开目录。 */
  revealPath(path: string): Promise<void>;
  notify(input: DesktopNotifyInput): Promise<unknown>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  getUpdateStatus(): Promise<DesktopUpdateStatus>;
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  onNotificationClick(listener: (sessionId: string | undefined) => void): () => void;
  onDeepLink(listener: (url: string) => void): () => void;
}

/** 必须存在的桥方法（缺任一即视为旧版/不合法，整体降级为 null）。 */
const REQUIRED_METHODS = [
  'getInfo',
  'setCloseToTray',
  'setOpenAtLogin',
  'openLogs',
  'restartHarness',
  'revealPath',
  'notify',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate',
  'getUpdateStatus',
  'onUpdateStatus',
  'onNotificationClick',
  'onDeepLink',
] as const;

/** 读取全局桥；结构不合法时返回 null（fail-safe）。 */
export function desktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { omni?: unknown }).omni;
  if (candidate === null || typeof candidate !== 'object') return null;
  const raw = candidate as Record<string, unknown>;
  if (raw['apiVersion'] !== 3) return null;
  for (const name of REQUIRED_METHODS) {
    if (typeof raw[name] !== 'function') return null;
  }
  const call = <T>(name: string, ...args: unknown[]): Promise<T> =>
    (raw[name] as (...values: unknown[]) => Promise<T>)(...args);
  const subscribe = <T>(name: string, listener: (value: T) => void): (() => void) =>
    (raw[name] as (value: (value: T) => void) => () => void)(listener);
  return {
    apiVersion: 3,
    getInfo: () => call<DesktopInfo>('getInfo'),
    setCloseToTray: (enabled) => call<void>('setCloseToTray', enabled),
    setOpenAtLogin: (enabled) => call<void>('setOpenAtLogin', enabled),
    openLogs: () => call<void>('openLogs'),
    restartHarness: () => call<void>('restartHarness'),
    revealPath: (path) => call<void>('revealPath', path),
    notify: (input) => call<unknown>('notify', input),
    checkForUpdates: () => call<void>('checkForUpdates'),
    downloadUpdate: () => call<void>('downloadUpdate'),
    installUpdate: () => call<void>('installUpdate'),
    getUpdateStatus: () => call<DesktopUpdateStatus>('getUpdateStatus'),
    onUpdateStatus: (listener) => subscribe<DesktopUpdateStatus>('onUpdateStatus', listener),
    onNotificationClick: (listener) =>
      subscribe<string | undefined>('onNotificationClick', listener),
    onDeepLink: (listener) => subscribe<string>('onDeepLink', listener),
  };
}

/**
 * 发桌面通知；无桌面桥时静默。
 * @param input 通知内容。
 * @returns 无返回值（fire-and-forget）。
 */
export function notifyDesktop(input: DesktopNotifyInput): void {
  const bridge = desktopBridge();
  if (bridge === null) return;
  void bridge.notify(input).catch(() => undefined);
}
