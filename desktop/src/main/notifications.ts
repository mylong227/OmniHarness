/** 原生通知：回合完成/待审批；窗口聚焦时不打扰。 */
import { Notification, type BrowserWindow } from 'electron';

/** 通知输入。 */
export interface NotifyInput {
  /** 标题（短）。 */
  readonly title: string;
  /** 正文（不默认包含提示词内容）。 */
  readonly body: string;
  /** 关联会话 id（点击时回传给 UI）。 */
  readonly sessionId?: string;
}

/** 通知服务。 */
export class NotificationService {
  /**
   * @param getWindow 当前主窗口。
   * @param onClick 点击通知后的导航回调。
   */
  public constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onClick: (sessionId: string | undefined) => void,
  ) {}

  /**
   * 显示通知。
   * @param input 通知内容。
   * @returns 是否已展示。
   */
  public show(input: NotifyInput): boolean {
    if (!Notification.isSupported()) return false;
    const window = this.getWindow();
    // 用户正在看窗口时不打扰；隐藏/失焦时才通知。
    if (window !== null && !window.isDestroyed() && window.isFocused() && window.isVisible()) {
      return false;
    }
    const notification = new Notification({
      title: NotificationService.limit(input.title, 120),
      body: NotificationService.limit(input.body, 500),
      silent: false,
    });
    notification.on('click', () => {
      const target = this.getWindow();
      if (target !== null && !target.isDestroyed()) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      }
      this.onClick(input.sessionId);
    });
    notification.show();
    return true;
  }

  /**
   * 截断文本，避免通知被系统截成乱码。
   * @param value 原文。
   * @param max 最大长度。
   * @returns 截断文本。
   */
  private static limit(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  }
}
