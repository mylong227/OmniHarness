/** 主窗口创建/加载/窗口状态。 */
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { DesktopStateStore, WindowBounds } from './desktopState.ts';
import type { HarnessHandle } from './harnessSupervisor.ts';

/** 创建窗口选项。 */
export interface MainWindowOptions {
  /** preload 绝对路径。 */
  readonly preload: string;
  /** 桌面偏好（窗口 bounds）。 */
  readonly state: DesktopStateStore;
}

/**
 * 让保存的 bounds 至少有一角落在当前显示器内。
 * @param bounds 保存的 bounds。
 * @returns 可用的 bounds。
 */
export function ensureVisibleBounds(bounds: WindowBounds | undefined): Rectangle {
  const fallback: Rectangle = { x: 120, y: 90, width: 1280, height: 860 };
  if (bounds === undefined) return fallback;
  const width = Math.max(900, Math.round(bounds.width));
  const height = Math.max(600, Math.round(bounds.height));
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      (bounds.x ?? 0) < area.x + area.width &&
      (bounds.x ?? 0) + width > area.x &&
      (bounds.y ?? 0) < area.y + area.height &&
      (bounds.y ?? 0) + height > area.y
    );
  });
  return visible
    ? { x: bounds.x ?? fallback.x, y: bounds.y ?? fallback.y, width, height }
    : { ...fallback, width, height };
}

/**
 * 创建主窗口并先显示加载页。
 * @param options 选项。
 * @returns 主窗口。
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const bounds = ensureVisibleBounds(options.state.get().window);
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'OmniHarness',
    backgroundColor: '#16181d',
    autoHideMenuBar: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      backgroundThrottling: false,
      preload: options.preload,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.on('close', () => {
    if (!window.isDestroyed()) {
      const current = window.getNormalBounds();
      options.state.rememberWindow({
        x: current.x,
        y: current.y,
        width: current.width,
        height: current.height,
      });
    }
  });
  void window.loadFile(join(__dirname, 'loading.html'));
  return window;
}

/**
 * 加载 Harness UI（带一次性 Token；服务端首屏会下发 HttpOnly Cookie）。
 * @param window 主窗口。
 * @param handle Harness 句柄。
 * @returns 无返回值。
 */
export function loadHarness(window: BrowserWindow, handle: HarnessHandle): void {
  const url = `http://127.0.0.1:${String(handle.port)}/?token=${encodeURIComponent(handle.token)}`;
  void window.loadURL(url);
}
