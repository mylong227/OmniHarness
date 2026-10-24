/** 主进程 IPC：只暴露语义化能力，不提供任意命令/任意路径。 */
import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { currentHarnessOrigin, openExternalSafely } from './security.ts';

/** IPC 依赖。 */
export interface IpcDeps {
  /** 当前主窗口 webContents（sender 校验）。 */
  mainContents(): WebContents | undefined;
  /** 当前工作区。 */
  workspace(): string;
  /** 选择工作区。 */
  pickWorkspace(): Promise<string | null>;
  /** 切换工作区并重启 Harness。 */
  openWorkspace(path: string): Promise<void>;
  /** 打开日志目录。 */
  openLogs(): Promise<void>;
  /** 重启 Harness。 */
  restartHarness(): Promise<void>;
  /** 退出应用。 */
  quit(): void;
}

/**
 * 注册 IPC。
 * @param deps 依赖。
 * @returns 无返回值。
 */
export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('omni:getInfo', (event) => {
    assertTrusted(event, deps);
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      workspace: deps.workspace(),
    };
  });
  ipcMain.handle('omni:pickWorkspace', async (event) => {
    assertTrusted(event, deps);
    return deps.pickWorkspace();
  });
  ipcMain.handle('omni:openWorkspace', async (event, path: unknown) => {
    assertTrusted(event, deps);
    if (typeof path !== 'string') throw new Error('invalid path');
    await deps.openWorkspace(path);
  });
  ipcMain.handle('omni:openLogs', async (event) => {
    assertTrusted(event, deps);
    await deps.openLogs();
  });
  ipcMain.handle('omni:openExternal', async (event, url: unknown) => {
    assertTrusted(event, deps);
    if (typeof url !== 'string') throw new Error('invalid url');
    await openExternalSafely(url);
  });
  ipcMain.handle('omni:restartHarness', async (event) => {
    assertTrusted(event, deps);
    await deps.restartHarness();
  });
  ipcMain.handle('omni:quit', (event) => {
    assertTrusted(event, deps);
    deps.quit();
  });
}

/**
 * 校验 IPC 来源：主窗口主 frame + 当前 harness origin。
 * @param event IPC 事件。
 * @param deps 依赖。
 * @returns 无返回值；不可信时抛错。
 */
function assertTrusted(event: IpcMainInvokeEvent, deps: IpcDeps): void {
  const main = deps.mainContents();
  if (main === undefined || event.sender !== main) throw new Error('ipc denied: sender');
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null) throw new Error('ipc denied: frame');
  const origin = currentHarnessOrigin();
  if (origin === '' || new URL(frame.url).origin !== origin) throw new Error('ipc denied: origin');
}

/**
 * 校验目录并返回绝对路径；不是目录时抛错。
 * @param path 路径。
 * @returns 绝对路径。
 */
export function assertDirectory(path: string): string {
  if (!existsSync(path)) throw new Error(`工作区不存在：${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`不是目录：${path}`);
  return path;
}

/**
 * 弹出原生目录选择。
 * @param defaultPath 默认路径。
 * @returns 选中路径或 null。
 */
export async function pickDirectory(defaultPath: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择工作区',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/**
 * 打开日志目录（失败时用系统文件管理器打开父目录）。
 * @param dir 目录。
 * @returns 无返回值。
 */
export async function openLogDirectory(dir: string): Promise<void> {
  const error = await shell.openPath(dir);
  if (error !== '') await shell.openPath(app.getPath('userData'));
}
