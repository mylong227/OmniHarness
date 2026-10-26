/**
 * 主窗口生命周期（单类）：显示/重建、关闭到托盘、开机启动、UI 诊断。
 *
 * 从 `main.ts` 抽出，目的是让启动编排只负责“顺序”，窗口行为集中在一处；
 * 本类不 import `app`，所有副作用经依赖回调注入。
 */
import type { BrowserWindow } from 'electron';
import type { DesktopStateStore } from '../desktopState.ts';
import type { HarnessHandle } from '../harnessSupervisor.ts';
import type { DesktopLogger } from '../logger.ts';
import type { TrayService } from '../tray.ts';

/** 窗口生命周期依赖。 */
export interface WindowLifecycleDeps {
  /** 当前窗口/句柄/托盘（bootstrap 前为 null）。 */
  current(): {
    window: BrowserWindow | null;
    handle: HarnessHandle | null;
    state: DesktopStateStore;
    tray: TrayService | null;
  } | null;
  /** 创建主窗口（含 preload/尺寸配置）。 */
  createWindow(): BrowserWindow;
  /** 把新窗口写回应用上下文。 */
  setWindow(window: BrowserWindow): void;
  /** 加载 Harness UI。 */
  loadHarness(window: BrowserWindow, handle: HarnessHandle): void;
  /** 重建原生菜单（托盘勾选状态同步）。 */
  refreshMenu(): void;
  /** 是否正在退出（退出流程不阻止关闭）。 */
  isQuitting(): boolean;
  /** 应用开机启动设置。 */
  applyAutoStart(enabled: boolean): void;
  /** 日志器（诊断事件用）。 */
  logger(): DesktopLogger | null;
}

/** 主窗口生命周期。 */
export class WindowLifecycle {
  /**
   * @param deps 应用上下文/窗口创建/菜单刷新等回调。
   */
  public constructor(private readonly deps: WindowLifecycleDeps) {}

  /** 创建一个新窗口（不改变主窗口上下文；多窗口复用）。 */
  public createWindow(): BrowserWindow {
    return this.deps.createWindow();
  }

  /** 显示/聚焦主窗口；窗口被关闭但 Harness 还在时重建。 */
  public show(): void {
    const ctx = this.deps.current();
    if (ctx === null) return;
    if (ctx.window === null && ctx.handle !== null) {
      const window = this.deps.createWindow();
      this.deps.setWindow(window);
      this.attach(window);
      this.deps.loadHarness(window, ctx.handle);
    }
    const window = this.deps.current()?.window ?? null;
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /**
   * 绑定窗口行为（关闭到托盘 + 加载/渲染诊断）。窗口重建时复用。
   * @param window 主窗口。
   * @returns 无返回值。
   */
  public attach(window: BrowserWindow): void {
    const logger = this.deps.logger();
    if (logger !== null) this.bindDiagnostics(window, logger);
    window.on('close', (event) => {
      if (this.deps.isQuitting()) return;
      const ctx = this.deps.current();
      if (ctx !== null && ctx.tray !== null && ctx.state.get().closeToTray === true) {
        event.preventDefault();
        window.hide();
      }
    });
  }

  /**
   * 设置关闭到托盘。
   * @param enabled 是否启用。
   * @returns 无返回值。
   */
  public setCloseToTray(enabled: boolean): void {
    const ctx = this.deps.current();
    if (ctx === null) return;
    ctx.state.setCloseToTray(enabled);
    ctx.tray?.refresh();
    this.deps.refreshMenu();
  }

  /**
   * 设置开机启动。
   * @param enabled 是否启用。
   * @returns 无返回值。
   */
  public setOpenAtLogin(enabled: boolean): void {
    const ctx = this.deps.current();
    if (ctx === null) return;
    ctx.state.setOpenAtLogin(enabled);
    this.deps.applyAutoStart(enabled);
    ctx.tray?.refresh();
    this.deps.refreshMenu();
  }

  /**
   * UI 加载/渲染崩溃诊断（不阻塞主流程）。
   * @param window 主窗口。
   * @param logger 日志器。
   * @returns 无返回值。
   */
  private bindDiagnostics(window: BrowserWindow, logger: DesktopLogger): void {
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
}
