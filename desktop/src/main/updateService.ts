/** 自动更新（electron-updater；签名/发布配置见 electron-builder.yml）。 */
import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { DesktopUpdateConfig } from './config.ts';

/** 更新状态（同时经 IPC 推给渲染层）。 */
export type UpdateStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'available'; readonly version: string }
  | { readonly state: 'downloading'; readonly percent: number }
  | { readonly state: 'downloaded'; readonly version: string }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'disabled'; readonly reason: string };

/** 更新服务。 */
export class UpdateService {
  private status: UpdateStatus = { state: 'idle' };

  /**
   * @param getWindow 主窗口（推送状态）。
   * @param beforeInstall 安装前收尾（停 Harness）。
   * @param config 更新策略（自动下载/预发布等）。
   */
  public constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly beforeInstall: () => Promise<void>,
    private readonly config: DesktopUpdateConfig,
  ) {}

  /**
   * 初始化事件监听；开发态/未打包时禁用（避免 electron-updater 在 dev 下报错）。
   * @returns 无返回值。
   */
  public initialize(): void {
    if (!app.isPackaged) {
      this.set({ state: 'disabled', reason: 'development' });
      return;
    }
    autoUpdater.autoDownload = this.config.autoDownload;
    autoUpdater.autoInstallOnAppQuit = this.config.autoInstallOnAppQuit;
    autoUpdater.allowPrerelease = this.config.allowPrerelease;
    autoUpdater.channel = this.config.channel;
    autoUpdater.allowDowngrade = this.config.allowDowngrade;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      this.set({ state: 'available', version: info.version }),
    );
    autoUpdater.on('update-not-available', () => this.set({ state: 'idle' }));
    autoUpdater.on('download-progress', (progress) =>
      this.set({ state: 'downloading', percent: Math.round(progress.percent) }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ state: 'downloaded', version: info.version }),
    );
    autoUpdater.on('error', (error) => this.set({ state: 'error', message: error.message }));
  }

  /**
   * 当前状态。
   * @returns 状态。
   */
  public current(): UpdateStatus {
    return this.status;
  }

  /**
   * 检查更新。
   * @returns 无返回值；错误写入状态。
   */
  public async check(): Promise<void> {
    if (!app.isPackaged) {
      this.set({ state: 'disabled', reason: 'development' });
      return;
    }
    try {
      this.set({ state: 'checking' });
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 下载已发现的更新。
   * @returns 无返回值。
   */
  public async download(): Promise<void> {
    if (!app.isPackaged) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.set({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 安装已下载的更新：先停 Harness，再退出安装。
   * @returns 无返回值。
   */
  public async install(): Promise<void> {
    if (!app.isPackaged) return;
    if (this.status.state !== 'downloaded') return;
    await this.beforeInstall();
    autoUpdater.quitAndInstall(false, true);
  }

  /**
   * 更新状态并推送。
   * @param status 新状态。
   * @returns 无返回值。
   */
  private set(status: UpdateStatus): void {
    this.status = status;
    const window = this.getWindow();
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send('omni:updateStatus', status);
    }
  }
}
