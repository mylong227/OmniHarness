/** OmniHarness 桌面主进程（Electron；按 Codex 官方 App 的 Electron + React/TS 形态）。 */
import { app, BrowserWindow, dialog, session } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopStateStore } from './desktopState.ts';
import { HarnessSupervisor, type HarnessHandle } from './harnessSupervisor.ts';
import { assertDirectory, openLogDirectory, pickDirectory, registerIpc } from './ipc.ts';
import { harnessEntry, logDir, nodeBinary, runDir } from './lib/paths.ts';
import { parseLaunchArgs } from './lib/args.ts';
import { DesktopLogger } from './logger.ts';
import { installMenu } from './menu.ts';
import { installGlobalGuards, installSessionSecurity, setHarnessOrigin } from './security.ts';
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
  quitting: boolean;
}

let context: AppContext | null = null;

/** 启动应用。 */
function run(): void {
  app.setAppUserModelId('com.mylong227.omniharness');
  app.enableSandbox();
  installGlobalGuards();

  app.on('second-instance', () => {
    const window = context?.window;
    if (window !== undefined && window !== null) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
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
  const initial = await resolveWorkspace(launch.workspace, state);
  if (initial === null) {
    logger.write('main', 'no workspace selected; quit');
    app.quit();
    return;
  }
  const window = createMainWindow({
    preload: join(__dirname, 'preload.cjs'),
    state,
  });
  bindUiDiagnostics(window, logger);
  const supervisor = new HarnessSupervisor({
    workspace: initial,
    entry: harnessEntry(),
    node: nodeBinary(),
    runDir: runDir(),
    logger,
  });
  context = {
    window,
    supervisor,
    handle: null,
    workspace: initial,
    logger,
    state,
    quitting: false,
  };
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
    quit: () => app.quit(),
    isPackaged: app.isPackaged,
  });
  registerIpc({
    mainContents: () => context?.window?.webContents,
    workspace: () => context?.workspace ?? initial,
    pickWorkspace: () => pickWorkspace(),
    openWorkspace: (path) => switchWorkspace(path),
    openLogs,
    restartHarness,
    quit: () => app.quit(),
  });

  try {
    const handle = await supervisor.start();
    context.handle = handle;
    setHarnessOrigin(handle.port);
    installSessionSecurity(session.defaultSession, handle.port);
    state.rememberWorkspace(initial);
    loadHarness(window, handle);
    logger.write('main', `UI loaded for workspace ${initial}`);
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
