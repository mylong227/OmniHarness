/** 应用菜单（最小集；与官方 App 一致的“文件/编辑/视图/帮助”）。 */
import { Menu, shell, type MenuItemConstructorOptions } from 'electron';

/** 菜单回调。 */
export interface MenuActions {
  openWorkspace(): void;
  openLogs(): void;
  restartHarness(): void;
  checkForUpdates(): void;
  closeToTray(): boolean;
  setCloseToTray(enabled: boolean): void;
  openAtLogin(): boolean;
  setOpenAtLogin(enabled: boolean): void;
  quit(): void;
  isPackaged: boolean;
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
      label: '文件',
      submenu: [
        { label: '打开工作区…', accelerator: 'CmdOrCtrl+O', click: actions.openWorkspace },
        { label: '重启 Harness', click: actions.restartHarness },
        { label: '检查更新', click: actions.checkForUpdates },
        { type: 'separator' },
        {
          label: '关闭时最小化到托盘',
          type: 'checkbox',
          checked: actions.closeToTray(),
          click: (item) => actions.setCloseToTray(item.checked),
        },
        {
          label: '开机启动',
          type: 'checkbox',
          checked: actions.openAtLogin(),
          click: (item) => actions.setOpenAtLogin(item.checked),
        },
        { type: 'separator' },
        { label: '打开日志目录', click: actions.openLogs },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: '退出', accelerator: 'Alt+F4', click: actions.quit }]),
      ],
    },
    {
      label: '编辑',
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
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(!actions.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'OmniHarness on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/mylong227/OmniHarness');
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
