/** 沙箱 preload：只暴露 window.omni 最小桥，不暴露 ipcRenderer/Node。 */
import { contextBridge, ipcRenderer } from 'electron';

/** 桥 API 版本（与 UI/壳握手；变更即 bump）。 */
const API_VERSION = 1;

const api = Object.freeze({
  apiVersion: API_VERSION,
  getInfo: () => ipcRenderer.invoke('omni:getInfo'),
  pickWorkspace: () => ipcRenderer.invoke('omni:pickWorkspace'),
  openWorkspace: (path: string) => ipcRenderer.invoke('omni:openWorkspace', path),
  openLogs: () => ipcRenderer.invoke('omni:openLogs'),
  openExternal: (url: string) => ipcRenderer.invoke('omni:openExternal', url),
  restartHarness: () => ipcRenderer.invoke('omni:restartHarness'),
  quit: () => ipcRenderer.invoke('omni:quit'),
});

contextBridge.exposeInMainWorld('omni', api);
