/** 系统托盘：显示窗口/打开工作区/日志/更新/退出。 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';

/** 托盘依赖的动作。 */
export interface TrayActions {
  show(): void;
  openWorkspace(): void;
  openLogs(): void;
  checkUpdates(): void;
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
   */
  public constructor(
    private readonly iconPath: string,
    private readonly actions: TrayActions,
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
      const tray = new Tray(image.resize({ width: 16, height: 16 }));
      tray.setToolTip('OmniHarness');
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
      { label: '显示 OmniHarness', click: () => this.actions.show() },
      { type: 'separator' },
      { label: '打开工作区…', click: () => this.actions.openWorkspace() },
      { label: '打开日志目录', click: () => this.actions.openLogs() },
      { label: '检查更新', click: () => this.actions.checkUpdates() },
      { type: 'separator' },
      {
        label: '关闭时最小化到托盘',
        type: 'checkbox',
        checked: this.actions.closeToTray(),
        click: (item) => {
          this.actions.setCloseToTray(item.checked);
          this.refresh();
        },
      },
      {
        label: '开机启动',
        type: 'checkbox',
        checked: this.actions.openAtLogin(),
        click: (item) => {
          this.actions.setOpenAtLogin(item.checked);
          this.refresh();
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => this.actions.quit() },
    ];
    return Menu.buildFromTemplate(template);
  }
}
