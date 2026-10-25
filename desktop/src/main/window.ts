/** 主窗口创建/加载/窗口状态。 */
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { DesktopStateStore, WindowBounds } from './desktopState.ts';
import type { HarnessHandle } from './harnessSupervisor.ts';

/** 启动页（内联 data URL：不依赖 asar 内文件路径，规避 packaged `ERR_FILE_NOT_FOUND`）。 */
const LOADING_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>OmniHarness</title>
<style>
:root{color-scheme:dark;--ink:#fdfcf9;--muted:#a9a39a;--bg:#16181d;--accent:#6f7bd8}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% 20%,#252a36 0%,var(--bg) 60%);
color:var(--ink);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none}
.wrap{display:grid;gap:18px;justify-items:center}
.mark{width:56px;height:56px;border-radius:14px;display:grid;place-items:center;background:#3d4a86;
font:32px/1 Georgia,serif;box-shadow:0 12px 40px rgba(61,74,134,.35)}
.spinner{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.18);
border-top-color:var(--accent);animation:spin .8s linear infinite}
.title{font-size:15px;letter-spacing:.08em}.hint{font-size:12px;color:var(--muted)}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap"><div class="mark">Ω</div><div class="spinner"></div>
<div class="title">OMNIHARNESS</div><div class="hint">正在启动本地 Harness…</div></div></body></html>`;
export interface MainWindowOptions {
  /** preload 绝对路径。 */
  readonly preload: string;
  /** 桌面偏好（窗口 bounds）。 */
  readonly state: DesktopStateStore;
  /** 是否在 ready-to-show 时自动显示（`--hidden`/开机启动时为 false）。 */
  readonly autoShow?: boolean;
}

/**
 * 让保存的 bounds 至少有一角落在当前显示器内。
 * @param bounds 保存的 bounds。
 * @returns 可用的 bounds。
 */
export function ensureVisibleBounds(bounds: WindowBounds | undefined): Rectangle {
  const primary = screen.getPrimaryDisplay().workArea;
  const fallbackWidth = Math.min(1280, primary.width);
  const fallbackHeight = Math.min(860, primary.height);
  const fallback: Rectangle = {
    x: primary.x + Math.max(0, Math.round((primary.width - fallbackWidth) / 2)),
    y: primary.y + Math.max(0, Math.round((primary.height - fallbackHeight) / 2)),
    width: fallbackWidth,
    height: fallbackHeight,
  };
  if (bounds === undefined) return fallback;
  // 只要求「有交集」不够：保存的窗口可能比当前屏幕高，底部（页脚/设置）会掉到屏幕外。
  // 这里按目标显示器的 workArea 同时夹取宽高与 x/y，窗口必须完整落在工作区内。
  const area = screen.getDisplayMatching({
    x: bounds.x ?? fallback.x,
    y: bounds.y ?? fallback.y,
    width: Math.max(900, Math.round(bounds.width)),
    height: Math.max(600, Math.round(bounds.height)),
  }).workArea;
  const width = Math.min(Math.max(900, Math.round(bounds.width)), area.width);
  const height = Math.min(Math.max(600, Math.round(bounds.height)), area.height);
  const x = Math.min(Math.max(bounds.x ?? fallback.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y ?? fallback.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
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
    icon: join(__dirname, 'icon.png'),
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

  window.once('ready-to-show', () => {
    if (options.autoShow !== false) window.show();
  });
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
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
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
