/**
 * 多窗口（2026-10-25）：同一 Harness 上再开一个工作台窗口。
 *
 * 只负责**额外窗口集合**；主窗口仍由 `WindowLifecycle` 管理。额外窗口关闭即销毁，
 * 不拦截为托盘；Harness 重启时由调用方统一 reload。
 */
import type { BrowserWindow, WebContents } from 'electron';
import type { HarnessHandle } from '../harnessSupervisor.ts';
import type { DesktopLogger } from '../logger.ts';

/** 多窗口依赖。 */
export interface SecondaryWindowsDeps {
  /** 创建窗口（复用主窗口的 preload/尺寸配置）。 */
  createWindow(): BrowserWindow;
  /** 加载 Harness UI。 */
  loadHarness(window: BrowserWindow, handle: HarnessHandle): void;
  /** 日志器。 */
  logger(): DesktopLogger | null;
}

/** 额外窗口集合。 */
export class SecondaryWindows {
  private readonly windows = new Set<BrowserWindow>();

  /**
   * @param deps 创建/加载/日志依赖。
   */
  public constructor(private readonly deps: SecondaryWindowsDeps) {}

  /**
   * 打开一个额外窗口并加载当前 Harness。
   * @param handle 当前 Harness 句柄。
   * @returns 新窗口（创建失败返回 null）。
   */
  public open(handle: HarnessHandle): BrowserWindow | null {
    try {
      const window = this.deps.createWindow();
      this.windows.add(window);
      window.on('closed', () => this.windows.delete(window));
      this.deps.loadHarness(window, handle);
      this.deps.logger()?.write('main', `secondary window opened (${String(this.windows.size)})`);
      return window;
    } catch (error) {
      this.deps
        .logger()
        ?.write(
          'main',
          `secondary window failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      return null;
    }
  }

  /**
   * 判断 IPC sender 是否属于额外窗口（多窗口下 IPC 信任面）。
   * @param contents sender webContents。
   * @returns 属于已知额外窗口为 true。
   */
  public owns(contents: WebContents): boolean {
    for (const window of this.windows) {
      if (!window.isDestroyed() && window.webContents === contents) return true;
    }
    return false;
  }

  /**
   * Harness 重启后刷新所有额外窗口。
   * @param handle 新句柄。
   * @returns 无返回值。
   */
  public reloadAll(handle: HarnessHandle): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) this.deps.loadHarness(window, handle);
    }
  }

  /** 关闭所有额外窗口（退出时清理）。 */
  public closeAll(): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) window.close();
    }
    this.windows.clear();
  }
}
