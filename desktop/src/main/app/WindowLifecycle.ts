/**
 * 主窗口生命周期（单类）：显示/重建、关闭到托盘、开机启动、UI 诊断与**渲染层自愈**。
 *
 * 从 `main.ts` 抽出，目的是让启动编排只负责“顺序”，窗口行为集中在一处；
 * 本类不 import `app`，所有副作用经依赖回调注入。
 */
import type { BrowserWindow } from 'electron';
import type { DesktopStateStore } from '../desktopState.ts';
import type { DesktopRecoveryConfig } from '../config/types.ts';
import type { HarnessHandle } from '../harnessSupervisor.ts';
import type { DesktopLogger } from '../logger.ts';
import type { TrayService } from '../tray.ts';
import { HarnessRestartPolicy } from './HarnessRestartPolicy.ts';

/** 渲染层故障种类（进日志与人机出口）。 */
export type UiGoneKind = 'load-failed' | 'renderer-gone';

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
  /** 渲染层自愈配置（缺省 undefined = 不启用自动恢复，行为与历史一致）。 */
  recovery?: DesktopRecoveryConfig;
  /** 自动恢复耗尽后的人机出口；返回 1 = 重试（清零计数并重载 UI），0/缺省 = 不动。 */
  onUiGone?(kind: UiGoneKind, detail: string): Promise<number>;
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
   * UI 加载/渲染崩溃诊断 + 渲染层自愈（不阻塞主流程）。
   *
   * 自愈口径（2026-10-27，此前两类事件**只写日志**——用户看到的是白屏/错误页，只能手动重启整个应用）：
   * - `did-fail-load`（仅主帧；`-3 ERR_ABORTED` 是「新加载取代旧加载」的正常取消，不恢复）
   *   ⇒ 延迟后用**当前句柄**重新 `loadHarness`（端口/令牌可能已变，重载旧 URL 没用）；
   * - `render-process-gone`（仅 `abnormal-exit`/`oom`/`memory-eviction` 这类「真崩了」的原因；
   *   `killed` 多为外部干预、`clean-exit` 常见于正常收尾，都不抢）⇒ 同样重载；
   * - 每类故障各自走 `HarnessRestartPolicy`（窗口内限次），耗尽后交 `onUiGone` 人机出口，
   *   用户选重试则清零计数再试一次——绝不让自愈本身变成无限重载循环。
   * @param window 主窗口。
   * @param logger 日志器。
   * @returns 无返回值。
   */
  private bindDiagnostics(window: BrowserWindow, logger: DesktopLogger): void {
    const recovery = this.deps.recovery;
    const loadFailPolicy =
      recovery === undefined
        ? null
        : new HarnessRestartPolicy(recovery.maxAttempts, recovery.windowMs);
    const rendererGonePolicy =
      recovery === undefined
        ? null
        : new HarnessRestartPolicy(recovery.maxAttempts, recovery.windowMs);
    let recovering = false;

    const reloadUi = (): void => {
      recovering = false;
      if (window.isDestroyed()) return;
      const handle = this.deps.current()?.handle ?? null;
      if (handle === null) return;
      this.deps.loadHarness(window, handle);
    };

    const attempt = (
      kind: UiGoneKind,
      detail: string,
      policy: HarnessRestartPolicy | null,
    ): void => {
      if (policy === null || recovering || this.deps.isQuitting()) return;
      const delayMs = recovery?.delayMs ?? 0;
      if (!policy.allow(Date.now())) {
        logger.write('main', `ui recovery exhausted kind=${kind} detail=${detail}`);
        void this.deps.onUiGone?.(kind, detail).then((response) => {
          if (response !== 1) return;
          policy.reset();
          recovering = true;
          setTimeout(reloadUi, delayMs);
        });
        return;
      }
      recovering = true;
      logger.write('main', `ui recovery: ${kind} reload in ${String(delayMs)}ms (${detail})`);
      setTimeout(reloadUi, delayMs);
    };

    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      logger.write('main', `ui load failed code=${String(code)} desc=${description} url=${url}`);
      // -3 ERR_ABORTED：有意的新加载（切工作区/重启 Harness）取代旧加载，属正常取消。
      if (isMainFrame === false || code === -3) return;
      attempt('load-failed', `code=${String(code)} desc=${description}`, loadFailPolicy);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      logger.write(
        'main',
        `renderer gone reason=${details.reason} exitCode=${String(details.exitCode)}`,
      );
      // Electron 没有 'crash' 档：Windows 下的真崩溃是 abnormal-exit，另有 oom / memory-eviction。
      const recoverable =
        details.reason === 'abnormal-exit' ||
        details.reason === 'oom' ||
        details.reason === 'memory-eviction';
      if (!recoverable) return;
      attempt('renderer-gone', `reason=${details.reason}`, rendererGonePolicy);
    });
  }
}
