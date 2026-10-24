/** 开机启动（Windows/macOS；Linux 暂不伪装支持）。 */
import { app } from 'electron';

/** 开机启动服务。 */
export class AutoStartService {
  /**
   * 应用当前设置。
   * @param enabled 是否开机启动。
   * @returns 无返回值；失败静默（不影响主流程）。
   */
  public static apply(enabled: boolean): void {
    if (process.platform === 'linux') return;
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: ['--hidden'],
      });
    } catch {
      // 系统策略/权限不允许时静默；UI 仍可手动启动。
    }
  }

  /**
   * 读取系统当前状态（不要只信本地偏好）。
   * @returns 是否已设置开机启动。
   */
  public static isEnabled(): boolean {
    if (process.platform === 'linux') return false;
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  }
}
