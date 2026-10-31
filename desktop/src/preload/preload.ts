/** 沙箱 preload：只暴露 window.omni 最小桥，不暴露 ipcRenderer/Node。 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

/** 桥 API 版本（与 UI/壳握手；变更即 bump）。 */
const API_VERSION = 3;

/** 通知输入（与主进程 NotifyInput 对齐）。 */
interface NotifyInput {
  readonly title: string;
  readonly body: string;
  readonly sessionId?: string;
}

/** 更新状态（与主进程 UpdateStatus 对齐）。 */
type UpdateStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'available'; readonly version: string }
  | { readonly state: 'downloading'; readonly percent: number }
  | { readonly state: 'downloaded'; readonly version: string }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'disabled'; readonly reason: string };

/**
 * 订阅主进程事件。
 * @param channel 通道。
 * @param listener 回调。
 * @returns 取消订阅函数。
 */
function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = Object.freeze({
  apiVersion: API_VERSION,
  getInfo: () => ipcRenderer.invoke('omni:getInfo'),
  setCloseToTray: (enabled: boolean) => ipcRenderer.invoke('omni:setCloseToTray', enabled),
  setOpenAtLogin: (enabled: boolean) => ipcRenderer.invoke('omni:setOpenAtLogin', enabled),
  pickWorkspace: () => ipcRenderer.invoke('omni:pickWorkspace'),
  openWorkspace: (path: string) => ipcRenderer.invoke('omni:openWorkspace', path),
  openLogs: () => ipcRenderer.invoke('omni:openLogs'),
  showDiagnostics: () => ipcRenderer.invoke('omni:showDiagnostics'),
  setProgress: (value: number) => ipcRenderer.invoke('omni:setProgress', value),
  openExternal: (url: string) => ipcRenderer.invoke('omni:openExternal', url),
  restartHarness: () => ipcRenderer.invoke('omni:restartHarness'),
  revealPath: (path: string) => ipcRenderer.invoke('omni:revealPath', path),
  notify: (input: NotifyInput) => ipcRenderer.invoke('omni:notify', input),
  checkForUpdates: () => ipcRenderer.invoke('omni:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('omni:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('omni:installUpdate'),
  getUpdateStatus: () => ipcRenderer.invoke('omni:getUpdateStatus'),
  /** 拖入文件的真实系统路径（Electron ≥32 移除 File.path 后，跨 contextBridge 的唯一正道）。 */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  /**
   * 壳层标题栏形态：win32 **无边框窗口**（系统标题栏与边线全去，UI 自绘标题条 + 窗口
   * 控制），其余平台原生。与 minimizeWindow / toggleMaximizeWindow / closeWindow 一样是
   * **纯增量**能力：旧版 UI 读不到就按 native 处理，故 API_VERSION 不为此 bump。
   */
  windowFrame: process.platform === 'win32' ? ('hidden' as const) : ('native' as const),
  minimizeWindow: () => ipcRenderer.invoke('omni:win:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('omni:win:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('omni:win:close'),
  onUpdateStatus: (listener: (status: UpdateStatus) => void) =>
    subscribe<UpdateStatus>('omni:updateStatus', listener),
  onNotificationClick: (listener: (sessionId: string | undefined) => void) =>
    subscribe<string | undefined>('omni:notificationClick', listener),
  onDeepLink: (listener: (url: string) => void) => subscribe<string>('omni:deepLink', listener),
  quit: () => ipcRenderer.invoke('omni:quit'),
});

contextBridge.exposeInMainWorld('omni', api);
