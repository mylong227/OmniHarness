/** OmniHarness 桌面主进程（Electron；按 Codex 官方 App 的 Electron + React/TS 形态）。 */
import { app, BrowserWindow, globalShortcut, session, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutoStartService } from './autoStart.ts';
import { DesktopStateStore } from './desktopState.ts';
import { HarnessSupervisor, type HarnessHandle } from './harnessSupervisor.ts';
import { assertDirectory, openLogDirectory, pickDirectory, registerIpc } from './ipc.ts';
import { harnessEntry, logDir, modelDir, nodeBinary, runDir, vectorDir } from './lib/paths.ts';
import { parseLaunchArgs } from './lib/args.ts';
import { loadDesktopConfig, type DesktopConfig } from './config.ts';
import { DesktopDialogs } from './app/DesktopDialogs.ts';
import { DeepLinkRouter } from './app/DeepLinkRouter.ts';
import { HarnessRestartPolicy } from './app/HarnessRestartPolicy.ts';
import { SecondaryWindows } from './app/SecondaryWindows.ts';
import { StartupMarker } from './app/StartupMarker.ts';
import { WindowLifecycle } from './app/WindowLifecycle.ts';
import { DesktopI18n } from './i18n/DesktopI18n.ts';
import { DesktopLogger } from './logger.ts';
import { installMenu, refreshMenu } from './menu.ts';
import { NotificationService } from './notifications.ts';
import { installGlobalGuards, installSessionSecurity, setHarnessOrigin } from './security.ts';
import { TrayService } from './tray.ts';
import { UpdateService } from './updateService.ts';
import { createMainWindow, loadHarness } from './window.ts';

app.setName('OmniHarness');

/**
 * 加载桌面配置（发布包文件 → 用户文件 → `OMNI_DESKTOP_CONFIG`）。
 *
 * 必须在 `app.setName` 之后（userData 路径取决于应用名）、`whenReady` 之前：
 * `app.getPath('userData')` 在主进程启动早期即可用。
 */
const loadedConfig = loadDesktopConfig({
  builtinFile: app.isPackaged
    ? join(process.resourcesPath, 'desktop.config.json')
    : join(app.getAppPath(), 'desktop.config.json'),
  userFile: join(app.getPath('userData'), 'desktop.config.json'),
  envFile: (process.env['OMNI_DESKTOP_CONFIG'] ?? '').trim(),
});
const config: DesktopConfig = loadedConfig.config;

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
  /** 原生壳文案（中/英）。 */
  i18n: DesktopI18n;
  /** 原生对话框统一入口。 */
  dialogs: DesktopDialogs;
}

let context: AppContext | null = null;

/** 深链路由（待处理 URL 由类持有，不再用全局变量）。 */
const deepLinks = new DeepLinkRouter({
  protocol: config.app.protocol,
  uiReadyTimeoutMs: config.deepLink.uiReadyTimeoutMs,
  getWindow: () => context?.window ?? null,
  isReady: () => context !== null,
  switchWorkspace: (path) => switchWorkspace(path),
});

/** 主窗口生命周期（显示/关闭到托盘/开机启动/诊断）。 */
const windows = new WindowLifecycle({
  current: () =>
    context === null
      ? null
      : {
          window: context.window,
          handle: context.handle,
          state: context.state,
          tray: context.tray,
        },
  createWindow: () => {
    if (context === null) throw new Error('window lifecycle not ready');
    return createMainWindow({
      preload: join(__dirname, 'preload.cjs'),
      state: context.state,
      config: config.window,
    });
  },
  setWindow: (window) => {
    if (context !== null) context.window = window;
  },
  loadHarness,
  refreshMenu,
  isQuitting: () => context?.quitting === true,
  applyAutoStart: (enabled) => AutoStartService.apply(enabled),
  logger: () => context?.logger ?? null,
});

/** 额外工作台窗口（多窗口）。 */
const secondary = new SecondaryWindows({
  createWindow: () => windows.createWindow(),
  loadHarness,
  logger: () => context?.logger ?? null,
});

/**
 * 新开一个工作台窗口（复用当前 Harness 句柄）。
 * @returns 无返回值。
 */
function openNewWindow(): void {
  const handle = context?.handle;
  if (handle === null || handle === undefined) return;
  secondary.open(handle);
}

/** 启动应用。 */
function run(): void {
  app.setAppUserModelId(config.app.appId);
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(config.app.protocol);
  } else if (process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient(config.app.protocol, process.execPath, [
      resolve(process.argv[1]),
    ]);
  }
  app.enableSandbox();
  installGlobalGuards();

  app.on('second-instance', (_event, argv) => {
    windows.show();
    const launch = parseLaunchArgs(argv, config.app.protocol);
    if (launch.workspace !== null) {
      void switchWorkspace(launch.workspace);
    } else if (launch.deepLink !== null) {
      void deepLinks.handle(launch.deepLink);
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    void deepLinks.handle(url);
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
        config: config.window,
      });
      windows.attach(context.window);
      loadHarness(context.window, context.handle);
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    secondary.closeAll();
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
      const i18n = new DesktopI18n(DesktopI18n.resolve(config.app.language, app.getLocale()));
      await new DesktopDialogs(i18n).startFailed(message);
      app.exit(1);
    });
}

/** 初始化：日志 → 偏好 → 工作区 → 窗口 → Harness → 载入 UI。 */
async function bootstrap(): Promise<void> {
  const logger = new DesktopLogger(logDir(app.getPath('userData'), config.logging.dirName), {
    ringLines: config.logging.ringLines,
  });
  for (const warning of loadedConfig.warnings) logger.write('main', `config: ${warning}`);
  const startup = new StartupMarker(logger);
  startup.mark('config.loaded');
  const i18n = new DesktopI18n(DesktopI18n.resolve(config.app.language, app.getLocale()));
  const dialogs = new DesktopDialogs(i18n);
  logger.write('main', `desktop language=${i18n.locale} (setting=${config.app.language})`);
  const state = new DesktopStateStore(app.getPath('userData'), {
    maxRecent: config.state.maxRecentWorkspaces,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    closeToTray: config.state.defaultCloseToTray,
    openAtLogin: config.state.defaultOpenAtLogin,
  });
  const launch = parseLaunchArgs(process.argv, config.app.protocol);
  const linkedWorkspace =
    launch.deepLink !== null
      ? DeepLinkRouter.workspaceOf(launch.deepLink, config.app.protocol)
      : null;
  const initial = await resolveWorkspace(launch.workspace ?? linkedWorkspace, state);
  if (initial === null) {
    logger.write('main', 'no workspace selected; quit');
    app.quit();
    return;
  }
  startup.mark('workspace.resolved');
  const window = createMainWindow({
    preload: join(__dirname, 'preload.cjs'),
    state,
    config: config.window,
    autoShow: !launch.hidden,
    loadingHint: i18n.t('window.starting'),
    loadingLang: i18n.locale,
  });
  startup.mark('window.created');
  const supervisor = createSupervisor(initial, logger);
  const notifications = new NotificationService(
    () => context?.window ?? null,
    (sessionId) => {
      const target = context?.window;
      if (target !== null && target !== undefined && !target.isDestroyed()) {
        target.webContents.send('omni:notificationClick', sessionId);
      }
    },
    config.notification,
  );
  const updates = new UpdateService(
    () => context?.window ?? null,
    async () => {
      if (context === null) return;
      context.quitting = true;
      await context.supervisor?.stop().catch(() => undefined);
    },
    config.update,
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
    i18n,
    dialogs,
  };
  windows.attach(window);
  const tray = new TrayService(
    join(__dirname, 'icon.png'),
    {
      show: () => windows.show(),
      newWindow: openNewWindow,
      openWorkspace: () => {
        void chooseWorkspace();
      },
      recentWorkspaces: () => (context?.state.get().recentWorkspaces ?? []).slice(0, 5),
      openRecent: (path) => {
        void switchWorkspace(path);
      },
      openLogs: () => {
        void openLogs();
      },
      checkUpdates: () => {
        void checkForUpdates();
      },
      diagnostics: () => {
        void showDiagnostics();
      },
      setCloseToTray: (enabled) => windows.setCloseToTray(enabled),
      setOpenAtLogin: (enabled) => windows.setOpenAtLogin(enabled),
      quit: () => app.quit(),
      closeToTray: () => context?.state.get().closeToTray === true,
      openAtLogin: () => context?.state.get().openAtLogin === true,
    },
    config.tray,
    i18n,
  );
  context.tray = tray.create() ? tray : null;
  if (config.window.showShortcut !== '') {
    try {
      const ok = globalShortcut.register(config.window.showShortcut, () => windows.show());
      logger.write(
        'main',
        ok
          ? `global shortcut registered: ${config.window.showShortcut}`
          : `global shortcut unavailable: ${config.window.showShortcut}`,
      );
    } catch (error) {
      logger.write(
        'main',
        `global shortcut failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (launch.hidden && context.tray === null) window.show();
  AutoStartService.apply(state.get().openAtLogin === true);
  updates.initialize();
  bindCrashHandler(supervisor);
  installMenu({
    openWorkspace: () => {
      void chooseWorkspace();
    },
    newWindow: openNewWindow,
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
    setCloseToTray: (enabled) => windows.setCloseToTray(enabled),
    openAtLogin: () => context?.state.get().openAtLogin === true,
    setOpenAtLogin: (enabled) => windows.setOpenAtLogin(enabled),
    quit: () => app.quit(),
    isPackaged: app.isPackaged,
    repositoryUrl: config.app.repositoryUrl,
    i18n,
  });
  registerIpc({
    limits: config.ipc,
    mainContents: () => context?.window?.webContents,
    isTrustedContents: (contents) => secondary.owns(contents),
    workspace: () => context?.workspace ?? initial,
    language: () => context?.i18n.locale ?? i18n.locale,
    showDiagnostics: () => {
      void showDiagnostics();
    },
    closeToTray: () => context?.state.get().closeToTray === true,
    setCloseToTray: (enabled) => windows.setCloseToTray(enabled),
    openAtLogin: () => context?.state.get().openAtLogin === true,
    setOpenAtLogin: (enabled) => windows.setOpenAtLogin(enabled),
    pickWorkspace: () => pickWorkspace(),
    openWorkspace: (path) => switchWorkspace(path),
    openLogs,
    restartHarness,
    revealPath,
    quit: () => app.quit(),
    notify: (input) => context?.notifications.show(input) === true,
    checkForUpdates,
    downloadUpdate: () => context?.updates.download() ?? Promise.resolve(),
    installUpdate: () => context?.updates.install() ?? Promise.resolve(),
    updateStatus: () => context?.updates.current() ?? { state: 'idle' },
  });
  if (app.isPackaged && config.update.autoCheckDelayMs > 0) {
    setTimeout(() => {
      void context?.updates.check();
    }, config.update.autoCheckDelayMs);
  }

  startup.mark('harness.start');
  try {
    const handle = await supervisor.start();
    context.handle = handle;
    startup.mark('harness.ready');
    setHarnessOrigin(handle.port, handle.host);
    installSessionSecurity(session.defaultSession, handle.port, {
      ...config.security,
      host: handle.host,
    });
    state.rememberWorkspace(initial);
    loadHarness(window, handle);
    startup.mark('ui.loading');
    logger.write('main', `UI loaded for workspace ${initial}`);
    if (launch.deepLink !== null) deepLinks.setPending(launch.deepLink);
    window.webContents.once('did-finish-load', () => {
      startup.mark('ui.ready');
      deepLinks.flush();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write('main', `harness start failed: ${message}`);
    await dialogs.harnessStartFailed(window, message, logger.directory());
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

/**
 * 按桌面配置构造 Harness 侧车（启动/切换工作区共用同一套路径与超时）。
 * @param workspace 工作区绝对路径。
 * @param logger 日志器。
 * @returns 侧车实例。
 */
function createSupervisor(workspace: string, logger: DesktopLogger): HarnessSupervisor {
  const userData = app.getPath('userData');
  return new HarnessSupervisor({
    workspace,
    entry: harnessEntry(),
    node: nodeBinary(),
    runDir: runDir(userData, config.harness.runDirName),
    modelDir: modelDir(userData, config.harness.modelDirName),
    vectorDir: vectorDir(userData, config.harness.vectorDirName),
    logger,
    config: config.harness,
  });
}

/** 菜单/IPC：选择并切换工作区。 */
async function chooseWorkspace(): Promise<void> {
  try {
    const picked = await pickWorkspace();
    if (picked !== null) await switchWorkspace(picked);
  } catch (error) {
    const ctx = context;
    ctx?.logger.write('main', `choose workspace failed: ${String(error)}`);
    if (ctx !== null) {
      await ctx.dialogs.workspaceOpenFailed(error instanceof Error ? error.message : String(error));
    }
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
    await ctx.dialogs.invalidWorkspace(error instanceof Error ? error.message : String(error));
    return;
  }
  if (absolute === ctx.workspace) return;
  ctx.logger.write('main', `switch workspace -> ${absolute}`);
  await ctx.supervisor?.stop();
  const next = createSupervisor(absolute, ctx.logger);
  bindCrashHandler(next);
  ctx.supervisor = next;
  try {
    const handle = await next.start();
    ctx.handle = handle;
    ctx.workspace = absolute;
    setHarnessOrigin(handle.port, handle.host);
    installSessionSecurity(session.defaultSession, handle.port, {
      ...config.security,
      host: handle.host,
    });
    ctx.state.rememberWorkspace(absolute);
    if (ctx.window !== null) loadHarness(ctx.window, handle);
    secondary.reloadAll(handle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.write('main', `switch workspace failed: ${message}`);
    await ctx.dialogs.switchFailed(message);
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
    setHarnessOrigin(handle.port, handle.host);
    installSessionSecurity(session.defaultSession, handle.port, {
      ...config.security,
      host: handle.host,
    });
    if (ctx.window !== null) loadHarness(ctx.window, handle);
    secondary.reloadAll(handle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.write('main', `restart failed: ${message}`);
    await ctx.dialogs.restartFailed(message);
  }
}

/** 打开日志目录。 */
async function openLogs(): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  await openLogDirectory(ctx.logger.directory());
}

/** 托盘「诊断信息」：把版本/工作区/侧车/日志/配置来源汇总到可复制对话框。 */
async function showDiagnostics(): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  const handle = ctx.handle;
  const detail = [
    `version: ${app.getVersion()}`,
    `workspace: ${ctx.workspace}`,
    `language: ${ctx.i18n.locale}`,
    `harness: ${ctx.supervisor?.getState() ?? 'none'}${
      handle !== null ? ` (${handle.host}:${String(handle.port)})` : ''
    }`,
    `logs: ${ctx.logger.directory()}`,
    `config: ${loadedConfig.sources.length > 0 ? loadedConfig.sources.join(' -> ') : 'builtin defaults'}`,
  ].join('\n');
  await ctx.dialogs.diagnostics(detail);
}

/**
 * 在系统文件管理器中打开目录。
 * @param path 目录路径（渲染层传入，必须再次校验）。
 * @returns 无返回值。
 */
async function revealPath(path: string): Promise<void> {
  const absolute = assertDirectory(path);
  const error = await shell.openPath(absolute);
  if (error !== '') throw new Error(error);
}

/** 检查更新（手动入口；开发态提示，不静默）。 */
async function checkForUpdates(): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  if (!app.isPackaged) {
    await ctx.dialogs.updateDev();
    return;
  }
  await ctx.updates.check();
  const status = ctx.updates.current();
  if (status.state === 'available') {
    const response = await ctx.dialogs.updateAvailable(status.version);
    if (response === 0) await ctx.updates.download();
    return;
  }
  if (status.state === 'downloaded') {
    const response = await ctx.dialogs.updateDownloaded(status.version);
    if (response === 0) await ctx.updates.install();
    return;
  }
  if (status.state === 'error') {
    await ctx.dialogs.updateFailed(status.message);
    return;
  }
  if (status.state === 'idle') {
    await ctx.dialogs.updateLatest();
  }
}

/**
 * 绑定崩溃处理：配置允许时按策略自动重启，超出上限才弹对话框。
 * @param supervisor 侧车。
 * @returns 无返回值。
 */
function bindCrashHandler(supervisor: HarnessSupervisor): void {
  const policy = new HarnessRestartPolicy(
    config.harness.restartMax,
    config.harness.restartWindowMs,
  );
  supervisor.on('crashed', (error: unknown) => {
    const ctx = context;
    if (ctx === null || ctx.quitting) return;
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.write('main', `harness crashed: ${message}`);
    if (config.harness.autoRestart && policy.allow(Date.now())) {
      ctx.logger.write(
        'main',
        `auto restart in ${String(config.harness.restartDelayMs)}ms (policy ${String(config.harness.restartMax)}/${String(config.harness.restartWindowMs)}ms)`,
      );
      setTimeout(() => {
        void restartHarness();
      }, config.harness.restartDelayMs);
      return;
    }
    void ctx.dialogs.crash(message, ctx.logger.directory()).then((response) => {
      if (response === 1) void restartHarness();
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
