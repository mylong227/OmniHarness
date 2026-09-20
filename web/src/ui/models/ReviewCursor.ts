// 变更审查游标：持有「当前选中块序号」与「快捷键帮助开关」的权威副本。
//
// 为什么不是纯 useState：键盘事件可能在同一帧内连续到达（用户按住 j），而 state 更新是异步的，
// 每次按键都从渲染快照读序号会漏掉前一次移动（实测：连按 3 次 j 只前进 1 格）。
// 故由本对象持有权威值，组件把它镜像进 state 仅用于渲染；两者不一致时以本对象为准。

import { ReviewKeyboard } from './ReviewKeyboard.js';
import type { ReviewAction } from './ReviewKeyboard.js';

/** 变更审查游标状态机（零 React 依赖，可直测）。 */
export class ReviewCursor {
  /** 当前选中块序号（-1 表示数据集为空或尚未选中）。 */
  private cursor = -1;

  /** 快捷键帮助是否展开。 */
  private helpOpen = false;

  /**
   * 取当前选中序号。
   * @returns 选中序号；无条目时为 -1
   */
  public at(): number {
    return this.cursor;
  }

  /**
   * 取帮助面板是否展开。
   * @returns 展开为 true
   */
  public helpVisible(): boolean {
    return this.helpOpen;
  }

  /**
   * 数据集或展开文件变化后重置：选中归首项，帮助保持（避免操作后帮助莫名关闭）。
   * @param count 新数据集的条目数
   * @returns 重置后的选中序号
   */
  public reset(count: number): number {
    this.cursor = ReviewKeyboard.clamp(0, count);
    return this.cursor;
  }

  /**
   * 渲染期同步：按当前条目数初始化 / 夹取选中序号（未选中即归首项）。
   * 「打开面板即有选中块」与「数据集变小后不越界」都靠这一步，故渲染路径必须经过它。
   * @param count 当前数据集条目数
   * @returns 同步后的选中序号
   */
  public sync(count: number): number {
    this.cursor = ReviewKeyboard.clamp(this.cursor, count);
    return this.cursor;
  }

  /**
   * 按动作移动选中（同时被夹取到合法区间）。
   * @param action 评审动作
   * @param count 当前数据集条目数
   * @returns 移动后的选中序号
   */
  public move(action: ReviewAction, count: number): number {
    this.cursor = ReviewKeyboard.move(this.cursor, action, count);
    return this.cursor;
  }

  /**
   * 开合快捷键帮助。
   * @returns 切换后的展开态
   */
  public toggleHelp(): boolean {
    this.helpOpen = !this.helpOpen;
    return this.helpOpen;
  }

  /**
   * 收起快捷键帮助（Esc 路径）。
   * @returns 无
   */
  public closeHelp(): void {
    this.helpOpen = false;
  }
}
