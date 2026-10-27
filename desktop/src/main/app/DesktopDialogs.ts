/**
 * 桌面原生对话框（中英统一入口）。
 *
 * 所有 `dialog.showMessageBox` 都从这里出：文案走 `DesktopI18n`，按钮返回 index 由调用方决策。
 * 这样 `main.ts` 不再散落中文字面量，新增语言也只改 `i18n/messages.ts`。
 */
import { dialog, type BrowserWindow } from 'electron';
import type { DesktopI18n } from '../i18n/DesktopI18n.ts';
import { openLogDirectory } from '../ipc.ts';

/** 对话框服务。 */
export class DesktopDialogs {
  /**
   * @param i18n 本地化文案。
   */
  public constructor(private readonly i18n: DesktopI18n) {}

  /** 应用启动失败（无窗口时）。 */
  public async startFailed(detail: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.startFailedTitle'),
      message: this.i18n.t('dialog.startFailedMessage'),
      detail,
    });
  }

  /** Harness 启动失败（有窗口时）。 */
  public async harnessStartFailed(
    window: BrowserWindow,
    detail: string,
    logDir: string,
  ): Promise<void> {
    const result = await dialog.showMessageBox(window, {
      type: 'error',
      title: this.i18n.t('dialog.harnessStartTitle'),
      message: this.i18n.t('dialog.harnessStartMessage'),
      detail: `${detail}\n\n${this.i18n.t('menu.openLogs')}: ${logDir}`,
      buttons: [this.i18n.t('dialog.quit'), this.i18n.t('dialog.openLogs')],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) {
      await openLogDirectory(logDir);
    }
  }

  /**
   * Harness 意外退出。
   * @returns 1 = 重启，0 = 退出。
   */
  public async crash(detail: string, logDir: string): Promise<number> {
    const result = await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.crashTitle'),
      message: this.i18n.t('dialog.crashMessage'),
      detail: `${detail}\n\n${this.i18n.t('menu.openLogs')}: ${logDir}`,
      buttons: [this.i18n.t('dialog.quit'), this.i18n.t('dialog.restart')],
      defaultId: 1,
      cancelId: 0,
    });
    return result.response;
  }

  /**
   * 渲染层自愈耗尽（UI 加载失败 / 渲染进程崩溃的自动恢复已达上限）。
   * @param kind 故障种类（进 detail 供排障）。
   * @param detail 故障细节（错误码 / 崩溃原因）。
   * @param logDir 日志目录。
   * @returns 1 = 重试（重新载入 UI），0 = 退出。
   */
  public async uiGone(
    kind: 'load-failed' | 'renderer-gone',
    detail: string,
    logDir: string,
  ): Promise<number> {
    const result = await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.uiGoneTitle'),
      message: this.i18n.t('dialog.uiGoneMessage'),
      detail: `${kind}: ${detail}\n\n${this.i18n.t('menu.openLogs')}: ${logDir}`,
      buttons: [this.i18n.t('dialog.quit'), this.i18n.t('dialog.restart')],
      defaultId: 1,
      cancelId: 0,
    });
    return result.response;
  }

  /**
   * 诊断信息（工作区/侧车/日志目录/版本）。
   * @param detail 可复制的诊断文本。
   */
  public async diagnostics(detail: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'info',
      title: this.i18n.t('dialog.diagnosticsTitle'),
      message: this.i18n.t('dialog.diagnosticsMessage'),
      detail,
    });
  }

  /** 打开工作区失败。 */
  public async workspaceOpenFailed(message: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.workspaceOpenFailed'),
      message,
    });
  }

  /** 工作区无效。 */
  public async invalidWorkspace(message: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.invalidWorkspace'),
      message,
    });
  }

  /** 切换工作区失败。 */
  public async switchFailed(detail: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.switchFailedTitle'),
      message: this.i18n.t('dialog.switchFailedMessage'),
      detail,
    });
  }

  /** 重启 Harness 失败。 */
  public async restartFailed(detail: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.restartFailedTitle'),
      message: this.i18n.t('dialog.restartFailedMessage'),
      detail,
    });
  }

  /** 开发构建检查更新的提示。 */
  public async updateDev(): Promise<void> {
    await dialog.showMessageBox({
      type: 'info',
      title: this.i18n.t('dialog.updateDevTitle'),
      message: this.i18n.t('dialog.updateDevMessage'),
      detail: this.i18n.t('dialog.updateDevDetail'),
    });
  }

  /**
   * 发现更新。
   * @returns 0 = 下载，1 = 稍后。
   */
  public async updateAvailable(version: string): Promise<number> {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: this.i18n.t('dialog.updateAvailableTitle'),
      message: this.i18n.t('dialog.updateAvailableMessage', { version }),
      detail: this.i18n.t('dialog.updateAvailableDetail'),
      buttons: [this.i18n.t('dialog.download'), this.i18n.t('dialog.later')],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response;
  }

  /**
   * 更新已下载。
   * @returns 0 = 立即安装，1 = 稍后。
   */
  public async updateDownloaded(version: string): Promise<number> {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: this.i18n.t('dialog.updateDownloadedTitle'),
      message: this.i18n.t('dialog.updateDownloadedMessage', { version }),
      detail: this.i18n.t('dialog.updateDownloadedDetail'),
      buttons: [this.i18n.t('dialog.installNow'), this.i18n.t('dialog.later')],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response;
  }

  /** 检查更新失败。 */
  public async updateFailed(message: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title: this.i18n.t('dialog.updateFailedTitle'),
      message: this.i18n.t('dialog.updateFailedMessage'),
      detail: message,
    });
  }

  /** 已是最新版本。 */
  public async updateLatest(): Promise<void> {
    await dialog.showMessageBox({
      type: 'info',
      title: this.i18n.t('dialog.updateLatestTitle'),
      message: this.i18n.t('dialog.updateLatestMessage'),
    });
  }
}
