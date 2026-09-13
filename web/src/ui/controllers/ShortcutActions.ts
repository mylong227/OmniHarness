// 全局快捷键的「动作 → 行为」执行器：把 KeyboardShortcuts 解析出的语义动作映射到具体 UI 行为。
// 与 KeyboardShortcuts（纯解析）配对——解析与执行分离，二者均可独立单测。
// 回调由组合根注入，本类不直接依赖任何控制器，避免出现反向依赖。

import type { ShortcutAction } from '../models/KeyboardShortcuts.js';

/** 快捷键动作的执行回调集合（由组合根注入）。 */
export interface ShortcutHandlers {
  /** 开合命令面板。 */
  togglePalette: () => void;
  /** 新建会话。 */
  newSession: () => void;
  /** 开合会话面板。 */
  toggleLeft: () => void;
  /** 开合工具面板。 */
  toggleRight: () => void;
  /** 切换浅色 / 深色主题。 */
  toggleTheme: () => void;
}

/** 快捷键执行器：无状态，仅持有注入的回调集合。 */
export class ShortcutActions {
  /**
   * @param handlers 各动作对应的执行回调
   */
  public constructor(private readonly handlers: ShortcutHandlers) {}

  /**
   * 执行动作对应的回调（动作与回调一一对应，未识别动作不触发任何行为）。
   * @param action 快捷键动作标识
   * @returns 无
   */
  public run(action: ShortcutAction): void {
    switch (action) {
      case 'palette':
        this.handlers.togglePalette();
        break;
      case 'newSession':
        this.handlers.newSession();
        break;
      case 'toggleLeft':
        this.handlers.toggleLeft();
        break;
      case 'toggleRight':
        this.handlers.toggleRight();
        break;
      case 'toggleTheme':
        this.handlers.toggleTheme();
        break;
    }
  }
}
