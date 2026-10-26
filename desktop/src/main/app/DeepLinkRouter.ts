/**
 * 深链路由器（`omniharness://open?workspace=...`）。
 *
 * 职责：解析 URL、在就绪后切工作区、把原始 URL 转发给已加载的 UI。
 * 待处理 URL 由本类持有，`main.ts` 不再维护全局 `pendingDeepLink`。
 */
import type { BrowserWindow } from 'electron';

/** 深链依赖（由 main 注入，便于不启动 Electron 时测试纯解析）。 */
export interface DeepLinkDeps {
  /** 桌面深链协议名（不含 `:`）。 */
  readonly protocol: string;
  /** 等待 UI 加载的上限（ms）。 */
  readonly uiReadyTimeoutMs: number;
  /** 当前主窗口；未创建时为 null。 */
  getWindow(): BrowserWindow | null;
  /** 应用上下文是否已就绪（bootstrap 之前收到的深链先排队）。 */
  isReady(): boolean;
  /** 切换工作区（main 的 switchWorkspace）。 */
  switchWorkspace(path: string): Promise<void>;
}

/** 深链路由器。 */
export class DeepLinkRouter {
  private pending: string | null = null;

  /**
   * @param deps 窗口/工作区/超时依赖。
   */
  public constructor(private readonly deps: DeepLinkDeps) {}

  /**
   * 从 URL 提取工作区（协议不符/解析失败返回 null）。
   * @param url 深链。
   * @param protocol 协议名（不含 `:`）。
   * @returns 工作区路径或 null。
   */
  public static workspaceOf(url: string, protocol: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== `${protocol}:`) return null;
      const workspace = parsed.searchParams.get('workspace');
      return workspace !== null && workspace.trim() !== '' ? workspace : null;
    } catch {
      return null;
    }
  }

  /**
   * 记录一个待处理深链（窗口尚未就绪时）。
   * @param url 深链。
   * @returns 无返回值。
   */
  public setPending(url: string): void {
    this.pending = url;
  }

  /**
   * 处理深链：就绪前只排队；就绪后必要时切工作区，再转发给 UI。
   * @param url 深链。
   * @returns 处理完成。
   */
  public async handle(url: string): Promise<void> {
    if (!this.deps.isReady()) {
      this.pending = url;
      return;
    }
    const workspace = DeepLinkRouter.workspaceOf(url, this.deps.protocol);
    if (workspace !== null) {
      await this.deps.switchWorkspace(workspace);
      const window = this.deps.getWindow();
      if (window !== null) await this.waitForUiReady(window);
    }
    this.pending = url;
    this.flush();
  }

  /**
   * 把待处理深链发给已加载的 UI（无待处理/无窗口时 no-op）。
   * @returns 无返回值。
   */
  public flush(): void {
    const window = this.deps.getWindow();
    if (window === null || this.pending === null) return;
    window.webContents.send('omni:deepLink', this.pending);
    this.pending = null;
  }

  /**
   * 等 UI 加载完成；超时也继续（避免深链把进程卡住）。
   * @param window 主窗口。
   * @returns 无返回值。
   */
  private waitForUiReady(window: BrowserWindow): Promise<void> {
    if (!window.webContents.isLoading()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.deps.uiReadyTimeoutMs);
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
