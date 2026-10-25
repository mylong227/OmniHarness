/** OmniHarness 桌面主进程（Electron；按 Codex 官方 App 的 Electron + React/TS 形态）。 */
import { app, BrowserWindow, dialog, session } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutoStartService } from './autoStart.ts';
import { DesktopStateStore } from './desktopState.ts';
import { HarnessSupervisor, type HarnessHandle } from './harnessSupervisor.ts';
import { assertDirectory, openLogDirectory, pickDirectory, registerIpc } from './ipc.ts';
import { harnessEntry, logDir, nodeBinary, runDir } from './lib/paths.ts';
import { parseLaunchArgs } from './lib/args.ts';
import { DesktopLogger } from './logger.ts';
import { installMenu, refreshMenu } from './menu.ts';
import { NotificationService } from './notifications.ts';
import { installGlobalGuards, installSessionSecurity, setHarnessOrigin } from './security.ts';
import { TrayService } from './tray.ts';
import { UpdateService } from './updateService.ts';
import { createMainWindow, loadHarness } from './window.ts';

app.setName('OmniHarness');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  run();
}

/** 应用级可变状态（只在主进程）。 */
interface AppContext {
  window: BrowserWindow | null;
  supervisor: HarnessSupervisor | null;
  handle: HarnessHandle | null;
  workspace: string;
  logger: DesktopLogger;
  state: DesktopStateStore;
  notifications: NotificationService;
  updates: UpdateService;
  tray: TrayService | null;
  quitting: boolean;
}

let context: AppContext | null = null;
let pendingDeepLink: string | null = null;

/** 启动应用。 */
function run(): void {
  app.setAppUserModelId('com.mylong227.omniharness');
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient('omniharness');
  } else if (process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient('omniharness', process.execPath, [resolve(process.argv[1])]);
  }
  app.enableSandbox();
  installGlobalGuards();

  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    const launch = parseLaunchArgs(argv);
    if (launch.workspace !== null) {
      void switchWorkspace(launch.workspace);
    } else if (launch.deepLink !== null) {
      void handleDeepLink(launch.deepLink);
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    void handleDeepLink(url);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (context === null) return;
    if (context.window === null && context.handle !== null) {
      context.window = createMainWindow({
        preload: join(__dirname, 'preload.cjs'),
        state: context.state,
      });
      attachWindowBehavior(context.window);
      loadHarness(context.window, context.handle);
    }
  });

  app.on('before-quit', (event) => {
    if (context === null || context.quitting) return;
    event.preventDefault();
    context.quitting = true;
    void shutdownAndExit(context);
  });

  void app
    .whenReady()
    .then(bootstrap)
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      context?.logger.write('main', `bootstrap failed: ${message}`);
      await dialog.showMessageBox({
        type: 'error',
        title: 'OmniHarness 无法启动',
        message: '桌面应用启动失败',
        detail: message,
      });
      app.exit(1);
    });
}

/** 初始化：日志 → 偏好 → 工作区 → 窗口 → Harness → 载入 UI。 */
async function bootstrap(): Promise<void> {
  const logger = new DesktopLogger(logDir());
  const state = new DesktopStateStore(app.getPath('userData'));
  const launch = parseLaunchArgs(process.argv);
  const linkedWorkspace = launch.deepLink !== null ? deepLinkWorkspace(launch.deepLink) : null;
  const initial = await resolveWorkspace(launch.workspace ?? linkedWorkspace, state);
  if (initial === null) {
    logger.write('main', 'no workspace selected; quit');
    app.quit();
    return;
  }
  const window = createMainWindow({
    preload: join(__dirname, 'preload.cjs'),
    state,
    autoShow: !launch.hidden,
  });
  const supervisor = new HarnessSupervisor({
    workspace: initial,
    entry: harnessEntry(),
    node: nodeBinary(),
    runDir: runDir(),
    logger,
  });
  const notifications = new NotificationService(
    () => context?.window ?? null,
    (sessionId) => {
      const target = context?.window;
      if (target !== null && target !== undefined && !target.isDestroyed()) {
        target.webContents.send('omni:notificationClick', sessionId);
      }
    },
  );
  const updates = new UpdateService(
    () => context?.window ?? null,
    async () => {
      if (context === null) return;
      context.quitting = true;
      await context.supervisor?.stop().catch(() => undefined);
    },
  );
  context = {
    window,
    supervisor,
    handle: null,
    workspace: initial,
    logger,
    state,
    notifications,
    updates,
    tray: null,
    quitting: false,
  };
  attachWindowBehavior(window);
  const tray = new TrayService(join(__dirname, 'icon.png'), {
    show: () => showMainWindow(),
    openWorkspace: () => {
      void chooseWorkspace();
    },
    openLogs: () => {
      void openLogs();
    },
    checkUpdates: () => {
      void checkForUpdates();
    },
    setCloseToTray: (enabled) => setCloseToTray(enabled),
    setOpenAtLogin: (enabled) => setOpenAtLogin(enabled),
    quit: () => app.quit(),
    closeToTray: () => context?.state.get().closeToTray === true,
    openAtLogin: () => context?.state.get().openAtLogin === true,
  });
  context.tray = tray.create() ? tray : null;
  if (launch.hidden && context.tray === null) window.show();
  AutoStartService.apply(state.get().openAtLogin === true);
  updates.initialize();
  bindCrashHandler(supervisor);
  installMenu({
    openWorkspace: () => {
      void chooseWorkspace();
    },
    openLogs: () => {
      void openLogs();
    },
    restartHarness: () => {
      void restartHarness();
    },
    checkForUpdates: () => {
      void checkForUpdates();
    },
    closeToTray: () => context?.state.get().closeToTray === true,
    setCloseToTray: (enabled) => setCloseToTray(enabled),
    openAtLogin: () => context?.state.get().openAtLogin === true,
    setOpenAtLogin: (enabled) => setOpenAtLogin(enabled),
    quit: () => app.quit(),
    isPackaged: app.isPackaged,
  });
  registerIpc({
    mainContents: () => context?.window?.webContents,
    workspace: () => context?.workspace ?? initial,
    closeToTray: () => context?.state.get().closeToTray === true,
    setCloseToTray,
    openAtLogin: () => context?.state.get().openAtLogin === true,
    setOpenAtLogin,
    pickWorkspace: () => pickWorkspace(),
    openWorkspace: (path) => switchWorkspace(path),
    openLogs,
    restartHarness,
    quit: () => app.quit(),
    notify: (input) => context?.notifications.show(input) === true,
    checkForUpdates,
    downloadUpdate: () => context?.updates.download() ?? Promise.resolve(),
    installUpdate: () => context?.updates.install() ?? Promise.resolve(),
    updateStatus: () => context?.updates.current() ?? { state: 'idle' },
  });
  if (app.isPackaged) {
    setTimeout(() => {
      void context?.updates.check();
    }, 10_000);
  }

  try {
    const handle = await supervisor.start();
    context.handle = handle;
    setHarnessOrigin(handle.port);
    installSessionSecurity(session.defaultSession, handle.port);
    state.rememberWorkspace(initial);
    loadHarness(window, handle);
    logger.write('main', `UI loaded for workspace ${initial}`);
    if (launch.deepLink !== null) pendingDeepLink = launch.deepLink;
    window.webContents.once('did-finish-load', () => flushDeepLink());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write('main', `harness start failed: ${message}`);
    await dialog
      .showMessageBox(window, {
        type: 'error',
        title: 'Harness 启动失败',
        message: '本地 Harness 未能启动',
        detail: `${message}\n\n日志：${logger.directory()}`,
        buttons: ['退出', '打开日志'],
        defaultId: 0,
        cancelId: 0,
      })
      .then((result) => {
        if (result.response === 1) void openLogDirectory(logger.directory());
      });
    app.quit();
  }
}

/**
 * 解析初始工作区：显式参数 > 上次工作区 > 原生选择框。
 * @param explicit 命令行 `--workspace`。
 * @param state 偏好。
 * @returns 工作区绝对路径；取消为 null。
 */
async function resolveWorkspace(
  explicit: string | null,
  state: DesktopStateStore,
): Promise<string | null> {
  if (explicit !== null) {
    if (!existsSync(explicit) || !statSync(explicit).isDirectory()) {
      throw new Error(`--workspace 不是有效目录：${explicit}`);
    }
    return explicit;
  }
  const remembered = state.get().workspace ?? state.get().recentWorkspaces[0];
  if (remembered !== undefined && existsSync(remembered) && statSync(remembered).isDirectory()) {
    return remembered;
  }
  return pickWorkspace();
}

/**
 * 弹出目录选择框。
 * @returns 选中路径或 null。
 */
async function pickWorkspace(): Promise<string | null> {
  return pickDirectory(app.getPath('documents'));
}

/** 菜单/IPC：选择并切换工作区。 */
async function chooseWorkspace(): Promise<void> {
  try {
    const picked = await pickWorkspace();
    if (picked !== null) await switchWorkspace(picked);
  } catch (error) {
    const ctx = context;
    ctx?.logger.write('main', `choose workspace failed: ${String(error)}`);
    await dialog.showMessageBox({
      type: 'error',
      title: '打开工作区失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 切换工作区：停旧 Harness → 起新 Harness → 重新载入 UI。
 * @param path 新工作区。
 * @returns 无返回值。
 */
async function switchWorkspace(path: string): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  let absolute: string;
  try {
    absolute = assertDirectory(path);
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: '工作区无效',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (absolute === ctx.workspace) return;
  ctx.logger.write('main', `switch workspace -> ${absolute}`);
  await ctx.supervisor?.stop();
  const next = new HarnessSupervisor({
    workspace: absolute,
    entry: harnessEntry(),
    node: nodeBinary(),
    runDir: runDir(),
    logger: ctx.logger,
  });
  bindCrashHandler(next);
  ctx.supervisor = next;
  try {
    const handle = await next.start();
    ctx.handle = handle;
    ctx.workspace = absolute;
    setHarnessOrigin(handle.port);
    installSessionSecurity(session.defaultSession, handle.port);
    ctx.state.rememberWorkspace(absolute);
    if (ctx.window !== null) loadHarness(ctx.window, handle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.write('main', `switch workspace failed: ${message}`);
    await dialog.showMessageBox({
      type: 'error',
      title: '切换工作区失败',
      message: '无法启动新工作区的 Harness',
      detail: message,
    });
  }
}

/**
 * 重启当前 Harness。
 * @returns 无返回值。
 */
async function restartHarness(): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  ctx.logger.write('main', 'restart harness requested');
  await ctx.supervisor?.stop();
  try {
    const handle = await ctx.supervisor?.start();
    if (handle === undefined) throw new Error('supervisor unavailable');
    ctx.handle = handle;
    setHarnessOrigin(handle.port);
    installSessionSecurity(session.defaultSession, handle.port);
    if (ctx.window !== null) loadHarness(ctx.window, handle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.write('main', `restart failed: ${message}`);
    await dialog.showMessageBox({
      type: 'error',
      title: '重启失败',
      message: 'Harness 未能重新启动',
      detail: message,
    });
  }
}

/** 打开日志目录。 */
async function openLogs(): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  await openLogDirectory(ctx.logger.directory());
}

/**
 * 从 `omniharness://open?workspace=...` 取出工作区。
 * @param url 深链。
 * @returns 工作区路径或 null。
 */
function deepLinkWorkspace(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'omniharness:') return null;
    const workspace = parsed.searchParams.get('workspace');
    return workspace !== null && workspace.trim() !== '' ? workspace : null;
  } catch {
    return null;
  }
}

/**
 * 处理深链：切换工作区并把原始 URL 转发给 UI。
 * @param url 深链。
 * @returns 无返回值。
 */
async function handleDeepLink(url: string): Promise<void> {
  const ctx = context;
  if (ctx === null) {
    pendingDeepLink = url;
    return;
  }
  const workspace = deepLinkWorkspace(url);
  if (workspace !== null) {
    await switchWorkspace(workspace);
    if (ctx.window !== null) await waitForUiReady(ctx.window);
  }
  pendingDeepLink = url;
  flushDeepLink();
}

/**
 * 等 UI 加载完成（最多 5s；超时也继续，避免深链把进程卡住）。
 * @param window 主窗口。
 * @returns 无返回值。
 */
function waitForUiReady(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 把待处理深链发给已加载的 UI。 */
function flushDeepLink(): void {
  const ctx = context;
  if (ctx === null || ctx.window === null || pendingDeepLink === null) return;
  ctx.window.webContents.send('omni:deepLink', pendingDeepLink);
  pendingDeepLink = null;
}

/** 显示/聚焦主窗口；窗口被关闭但 Harness 还在时重建。 */
function showMainWindow(): void {
  const ctx = context;
  if (ctx === null) return;
  if (ctx.window === null && ctx.handle !== null) {
    const window = createMainWindow({
      preload: join(__dirname, 'preload.cjs'),
      state: ctx.state,
    });
    ctx.window = window;
    attachWindowBehavior(window);
    loadHarness(window, ctx.handle);
  }
  const window = ctx.window;
  if (window === null) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * 设置关闭到托盘。
 * @param enabled 是否启用。
 * @returns 无返回值。
 */
function setCloseToTray(enabled: boolean): void {
  const ctx = context;
  if (ctx === null) return;
  ctx.state.setCloseToTray(enabled);
  ctx.tray?.refresh();
  refreshMenu();
}

/**
 * 设置开机启动。
 * @param enabled 是否启用。
 * @returns 无返回值。
 */
function setOpenAtLogin(enabled: boolean): void {
  const ctx = context;
  if (ctx === null) return;
  ctx.state.setOpenAtLogin(enabled);
  AutoStartService.apply(enabled);
  ctx.tray?.refresh();
  refreshMenu();
}

/** 检查更新（手动入口；开发态提示，不静默）。 */
async function checkForUpdates(): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: '检查更新',
      message: '开发构建不启用自动更新',
      detail: '请使用打包后的安装版本；更新源由 electron-builder 的 publish 配置提供。',
    });
    return;
  }
  await ctx.updates.check();
  const status = ctx.updates.current();
  if (status.state === 'available') {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `OmniHarness ${status.version} 可用`,
      detail: '是否现在下载？下载完成后会在你确认时安装。',
      buttons: ['下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) await ctx.updates.download();
    return;
  }
  if (status.state === 'downloaded') {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: '更新已下载',
      message: `OmniHarness ${status.version} 已下载`,
      detail: '安装会先停止本地 Harness，然后重启应用。',
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) await ctx.updates.install();
    return;
  }
  if (status.state === 'error') {
    await dialog.showMessageBox({
      type: 'error',
      title: '检查更新失败',
      message: '无法检查更新',
      detail: status.message,
    });
    return;
  }
  if (status.state === 'idle') {
    await dialog.showMessageBox({
      type: 'info',
      title: '检查更新',
      message: '当前已是最新版本',
    });
  }
}

/**
 * 绑定崩溃处理：Harness 意外退出时提示并退出（MVP；后续做自动重启）。
 * @param supervisor 侧车。
 * @returns 无返回值。
 */
function bindCrashHandler(supervisor: HarnessSupervisor): void {
  supervisor.on('crashed', (error: unknown) => {
    const ctx = context;
    if (ctx === null || ctx.quitting) return;
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.write('main', `harness crashed: ${message}`);
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'Harness 已退出',
        message: '本地 Harness 意外退出',
        detail: `${message}\n\n日志：${ctx.logger.directory()}`,
        buttons: ['退出', '重启'],
        defaultId: 1,
        cancelId: 0,
      })
      .then((result) => {
        if (result.response === 1) void restartHarness();
        else app.quit();
      });
  });
}

/** 停止 Harness 并退出。 */
async function shutdownAndExit(ctx: AppContext): Promise<void> {
  ctx.logger.write('main', 'shutting down');
  await ctx.supervisor?.stop().catch(() => undefined);
  ctx.logger.close();
  app.exit(0);
}

/**
 * 绑定窗口行为（关闭到托盘/加载诊断）。窗口重建时复用。
 * @param window 主窗口。
 * @returns 无返回值。
 */
function attachWindowBehavior(window: BrowserWindow): void {
  const ctx = context;
  if (ctx === null) return;
  bindUiDiagnostics(window, ctx.logger);
  window.on('close', (event) => {
    if (ctx.quitting) return;
    if (ctx.tray !== null && ctx.state.get().closeToTray === true) {
      event.preventDefault();
      window.hide();
    }
  });
}

/**
 * 绑定 UI 加载/渲染崩溃日志（不阻塞主流程）。
 * @param window 主窗口。
 * @param logger 日志器。
 * @returns 无返回值。
 */
function bindUiDiagnostics(window: BrowserWindow, logger: DesktopLogger): void {
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger.write('main', `ui load failed code=${String(code)} desc=${description} url=${url}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.write(
      'main',
      `renderer gone reason=${details.reason} exitCode=${String(details.exitCode)}`,
    );
  });
}
