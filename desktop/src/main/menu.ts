/** 应用菜单（最小集；与官方 App 一致的“文件/编辑/视图/帮助”）。 */
import { Menu, type MenuItemConstructorOptions } from 'electron';

/** 菜单回调。 */
export interface MenuActions {
  openWorkspace(): void;
  openLogs(): void;
  restartHarness(): void;
  quit(): void;
  isPackaged: boolean;
}

/**
 * 构建并设置应用菜单。
 * @param actions 回调。
 * @returns 无返回值。
 */
export function installMenu(actions: MenuActions): void {
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
            void import('electron').then(({ shell }) =>
              shell.openExternal('https://github.com/mylong227/OmniHarness'),
            );
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
