/** 沙箱 preload：只暴露 window.omni 最小桥，不暴露 ipcRenderer/Node。 */
import { contextBridge, ipcRenderer } from 'electron';

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
  onUpdateStatus: (listener: (status: UpdateStatus) => void) =>
    subscribe<UpdateStatus>('omni:updateStatus', listener),
  onNotificationClick: (listener: (sessionId: string | undefined) => void) =>
    subscribe<string | undefined>('omni:notificationClick', listener),
  onDeepLink: (listener: (url: string) => void) => subscribe<string>('omni:deepLink', listener),
  quit: () => ipcRenderer.invoke('omni:quit'),
});

contextBridge.exposeInMainWorld('omni', api);
