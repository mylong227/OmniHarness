/** 应用菜单（最小集；与官方 App 一致的“文件/编辑/视图/帮助”）。 */
import { Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { DesktopI18n } from './i18n/DesktopI18n.ts';

/** 菜单回调。 */
export interface MenuActions {
  openWorkspace(): void;
  openLogs(): void;
  restartHarness(): void;
  /** 新开一个工作台窗口（多窗口）。 */
  newWindow?(): void;
  checkForUpdates(): void;
  closeToTray(): boolean;
  setCloseToTray(enabled: boolean): void;
  openAtLogin(): boolean;
  setOpenAtLogin(enabled: boolean): void;
  quit(): void;
  isPackaged: boolean;
  /** 「帮助」菜单打开的仓库地址。 */
  readonly repositoryUrl: string;
  /** 本地化文案（中/英由配置决定）。 */
  readonly i18n: DesktopI18n;
}

/** 最近一次菜单动作（设置变化时重建勾选状态）。 */
let lastActions: MenuActions | null = null;

/**
 * 重建菜单（勾选项变化后调用）。
 * @returns 无返回值。
 */
export function refreshMenu(): void {
  if (lastActions !== null) installMenu(lastActions);
}

/**
 * 构建并设置应用菜单。
 * @param actions 回调。
 * @returns 无返回值。
 */
export function installMenu(actions: MenuActions): void {
  lastActions = actions;
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'OmniHarness',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: actions.i18n.t('menu.file'),
      submenu: [
        {
          label: actions.i18n.t('menu.openWorkspace'),
          accelerator: 'CmdOrCtrl+O',
          click: actions.openWorkspace,
        },
        { label: actions.i18n.t('menu.restartHarness'), click: actions.restartHarness },
        { label: actions.i18n.t('menu.checkUpdates'), click: actions.checkForUpdates },
        { type: 'separator' },
        {
          label: actions.i18n.t('menu.closeToTray'),
          type: 'checkbox',
          checked: actions.closeToTray(),
          click: (item) => actions.setCloseToTray(item.checked),
        },
        {
          label: actions.i18n.t('menu.openAtLogin'),
          type: 'checkbox',
          checked: actions.openAtLogin(),
          click: (item) => actions.setOpenAtLogin(item.checked),
        },
        { type: 'separator' },
        { label: actions.i18n.t('menu.openLogs'), click: actions.openLogs },
        { type: 'separator' },
        ...(isMac
          ? []
          : [
              {
                label: actions.i18n.t('menu.quit'),
                accelerator: 'Alt+F4',
                click: actions.quit,
              },
            ]),
      ],
    },
    {
      label: actions.i18n.t('menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: actions.i18n.t('menu.view'),
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(!actions.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        ...(actions.newWindow !== undefined
          ? [
              {
                label: actions.i18n.t('menu.newWindow'),
                accelerator: 'CmdOrCtrl+Shift+N',
                click: actions.newWindow,
              },
              { type: 'separator' as const },
            ]
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: actions.i18n.t('menu.help'),
      submenu: [
        {
          label: actions.i18n.t('menu.repository'),
          click: () => {
            void shell.openExternal(actions.repositoryUrl);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
