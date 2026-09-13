// 全局键盘快捷键：把按键事件解析为语义化动作（零 DOM 依赖，可在 node 中直测）。
//
// 设计意图：命令面板的 hint 文案与全局 keydown 监听「共用同一份绑定表」，
// 避免出现「面板里提示 Ctrl+B、实际却没绑定」这类提示与行为漂移。
// 接线点：web/src/ui/controllers/AppController 的 keydown 监听；文案消费方：AppReducers.buildCommands。

/** 全局快捷键动作标识。 */
export type ShortcutAction =
  | 'palette'
  | 'newSession'
  | 'toggleLeft'
  | 'toggleRight'
  | 'toggleTheme';

/** 解析所需的最小按键信息（KeyboardEvent 的结构子集，便于单测构造）。 */
export interface ShortcutKeyLike {
  /** 按键名（`KeyboardEvent.key`，大小写不敏感）。 */
  key: string;
  /** 是否按下 Ctrl。 */
  ctrlKey: boolean;
  /** 是否按下 Cmd（macOS）。 */
  metaKey: boolean;
  /** 是否按下 Shift。 */
  shiftKey: boolean;
}

/** 一条快捷键绑定。 */
interface ShortcutBinding {
  /** 命中后返回的动作标识。 */
  action: ShortcutAction;
  /** 面向用户展示的快捷键文案（命令面板 hint 的单一来源）。 */
  label: string;
  /** 命中的按键名集合（小写）。 */
  keys: readonly string[];
  /** Shift 要求：`with` 必须按下 / `without` 必须不按 / `any` 不关心。 */
  shift: 'with' | 'without' | 'any';
}

/**
 * 快捷键绑定表（唯一来源）。
 * 全部要求 Ctrl 或 Cmd 同按——裸键一律放行，避免劫持正文输入。
 */
const BINDINGS: readonly ShortcutBinding[] = [
  { action: 'palette', label: 'Ctrl/Cmd+P', keys: ['p', 'k'], shift: 'any' },
  { action: 'newSession', label: 'Ctrl/Cmd+N', keys: ['n'], shift: 'without' },
  { action: 'toggleLeft', label: 'Ctrl/Cmd+B', keys: ['b'], shift: 'without' },
  { action: 'toggleRight', label: 'Ctrl/Cmd+Shift+E', keys: ['e'], shift: 'with' },
  { action: 'toggleTheme', label: 'Ctrl/Cmd+Shift+L', keys: ['l'], shift: 'with' },
];

/** 无状态快捷键解析器：组合根持有一份实例即可（不在方法体内 new）。 */
export class KeyboardShortcuts {
  /**
   * 解析按键事件为动作标识。
   * @param e 按键信息（仅取 key / ctrlKey / metaKey / shiftKey）
   * @returns 命中的动作标识；未命中任何快捷键时为 null
   */
  public resolve(e: ShortcutKeyLike): ShortcutAction | null {
    if (!e.ctrlKey && !e.metaKey) return null;
    const key = e.key.toLowerCase();
    for (const binding of BINDINGS) {
      if (!binding.keys.includes(key)) continue;
      if (binding.shift === 'with' && !e.shiftKey) continue;
      if (binding.shift === 'without' && e.shiftKey) continue;
      return binding.action;
    }
    return null;
  }

  /**
   * 取某动作的展示文案（与 `resolve` 的判定同源，杜绝提示与行为漂移）。
   * @param action 动作标识
   * @returns 快捷键文案；动作无绑定时为空串
   */
  public label(action: ShortcutAction): string {
    const binding = BINDINGS.find((b) => b.action === action);
    return binding ? binding.label : '';
  }
}
