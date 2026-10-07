// 文件夹选择器的按键判定（零 DOM 依赖，可 node 单测）。
//
// ## 为什么必须抽出来（2026-10-07 用户报障「输入就直接退出了新建文件夹」）
//
// 旧实现把判定内联在 FolderPicker 的 window keydown 监听里，且**新建态分支忘了先判断按键**：
// `if (creating) { 退出新建; return; }` 对**任何**键都生效——用户在命名框里敲的每个字母都被
// 全局监听抢先当成「退出新建」处理，命名框根本打不了字。抽成纯函数后：
//   · 判定有单一事实源（输入框的 Enter 与 window 的 Esc 共用一份规则）；
//   · 判定可单测（「字母键不退新建」这条回归判据可以钉住）；
//   · 中文输入法的**组合期**（isComposing）显式放行——组词中的 Enter/字母属于输入法，不是指令。

/** 按键判定结果。 */
export type PickerKeyAction =
  /** 退出「新建文件夹」命名态（回到浏览层）。 */
  | 'exit-create'
  /** 关闭整个选择器弹窗。 */
  | 'close-picker'
  /** 确认创建（命名框内按 Enter）。 */
  | 'confirm-create'
  /** 非指令键（普通输入，交给输入框）。 */
  | null;

/** 文件夹选择器的按键判定规则（纯静态，无状态）。 */
export class PickerKeys {
  /**
   * 解析一次按键。
   * @param key `KeyboardEvent.key`
   * @param opts `creating` 是否处于新建命名态；`composing` 是否处于输入法组合期
   * @returns 判定结果；普通输入返回 null
   */
  public static resolve(key: string, opts: { creating: boolean; composing: boolean }): PickerKeyAction {
    // 组合期（中文输入法选词中）：所有键都属于输入法，UI 不抢。
    if (opts.composing) return null;
    if (key === 'Escape') return opts.creating ? 'exit-create' : 'close-picker';
    if (key === 'Enter' && opts.creating) return 'confirm-create';
    return null;
  }
}
