// 输入框回填（F4「编辑重发」）：把末条用户消息写回底部输入框的纯逻辑。
// 组件保持非受控（直接读写 textarea.value），故把「写入 + 聚焦 + 光标归位」抽成模型，
// 组件内只留一行接线；模型零 DOM 依赖、可被最小桩单测。

/** 可回填的目标元素（真实实现为 HTMLTextAreaElement；单测传最小桩）。 */
export interface DraftTarget {
  /** 输入框当前文本（非受控：直接读写 DOM 值）。 */
  value: string;
  /** 聚焦输入框，便于用户直接续写。 */
  focus(): void;
  /** 把光标定位到 [start, end)（可选，非浏览器桩可省略）。 */
  setSelectionRange?(start: number, end: number): void;
}

/** 输入框回填器：单一职责——把一段文本写进输入框并接管焦点 / 光标。 */
export class ComposerDraft {
  /**
   * 把文本填回输入框：写入值 → 聚焦 → 光标落到末尾，用户可直接继续编辑。
   * @param target 目标输入框（null 时静默跳过：输入框尚未挂载不该抛错）。
   * @param text 待回填文本
   * @returns 无
   */
  public static fill(target: DraftTarget | null, text: string): void {
    if (target === null) return;
    target.value = text;
    target.focus();
    const end = text.length;
    if (typeof target.setSelectionRange === 'function') target.setSelectionRange(end, end);
  }
}
