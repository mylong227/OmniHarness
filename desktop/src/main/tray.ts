/** 系统托盘：显示窗口/打开工作区/日志/更新/退出。 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import type { DesktopI18n } from './i18n/DesktopI18n.ts';
import type { DesktopTrayConfig } from './config.ts';

/** 托盘依赖的动作。 */
export interface TrayActions {
  show(): void;
  /** 新开工作台窗口。 */
  newWindow(): void;
  openWorkspace(): void;
  /** 最近工作区（最多 5 条，按最近使用排序）。 */
  recentWorkspaces(): readonly string[];
  /** 打开最近工作区。 */
  openRecent(path: string): void;
  openLogs(): void;
  checkUpdates(): void;
  diagnostics(): void;
  setCloseToTray(enabled: boolean): void;
  setOpenAtLogin(enabled: boolean): void;
  quit(): void;
  closeToTray(): boolean;
  openAtLogin(): boolean;
}

/** 托盘服务。 */
export class TrayService {
  private tray: Tray | null = null;

  /**
   * @param iconPath 托盘图标路径（dist/icon.png）。
   * @param actions 动作。
   * @param config 图标尺寸与提示文案。
   */
  public constructor(
    private readonly iconPath: string,
    private readonly actions: TrayActions,
    private readonly config: DesktopTrayConfig,
    private readonly i18n: DesktopI18n,
  ) {}

  /**
   * 创建托盘（图标缺失时静默跳过，不阻塞主流程）。
   * @returns 是否创建成功。
   */
  public create(): boolean {
    if (this.tray !== null) return true;
    if (!existsSync(this.iconPath)) return false;
    try {
      const image = nativeImage.createFromPath(this.iconPath);
      if (image.isEmpty()) return false;
      const tray = new Tray(
        image.resize({ width: this.config.iconSize, height: this.config.iconSize }),
      );
      tray.setToolTip(this.config.tooltip);
      tray.setContextMenu(this.menu());
      tray.on('click', () => this.actions.show());
      tray.on('double-click', () => this.actions.show());
      this.tray = tray;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 销毁托盘。
   * @returns 无返回值。
   */
  public destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /**
   * 刷新菜单（设置变化后调用）。
   * @returns 无返回值。
   */
  public refresh(): void {
    this.tray?.setContextMenu(this.menu());
  }

  /**
   * 构建原生菜单。
   * @returns 菜单。
   */
  private menu(): Menu {
    const template: MenuItemConstructorOptions[] = [
      { label: this.i18n.t('tray.show'), click: () => this.actions.show() },
      { label: this.i18n.t('tray.newWindow'), click: () => this.actions.newWindow() },
      { type: 'separator' },
      { label: this.i18n.t('tray.openWorkspace'), click: () => this.actions.openWorkspace() },
      {
        label: this.i18n.t('tray.recent'),
        submenu:
          this.actions.recentWorkspaces().length > 0
            ? this.actions.recentWorkspaces().map((path) => ({
                label: path,
                click: () => this.actions.openRecent(path),
              }))
            : [{ label: this.i18n.t('tray.noRecent'), enabled: false }],
      },
      { label: this.i18n.t('tray.openLogs'), click: () => this.actions.openLogs() },
      { label: this.i18n.t('tray.checkUpdates'), click: () => this.actions.checkUpdates() },
      { label: this.i18n.t('tray.diagnostics'), click: () => this.actions.diagnostics() },
      { type: 'separator' },
      {
        label: this.i18n.t('tray.closeToTray'),
        type: 'checkbox',
        checked: this.actions.closeToTray(),
        click: (item) => {
          this.actions.setCloseToTray(item.checked);
          this.refresh();
        },
      },
      {
        label: this.i18n.t('tray.openAtLogin'),
        type: 'checkbox',
        checked: this.actions.openAtLogin(),
        click: (item) => {
          this.actions.setOpenAtLogin(item.checked);
          this.refresh();
        },
      },
      { type: 'separator' },
      { label: this.i18n.t('tray.quit'), click: () => this.actions.quit() },
    ];
    return Menu.buildFromTemplate(template);
  }
}
