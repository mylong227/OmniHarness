// 剪贴板写入（2026-10-31 用户口径：要**真实复制成功**——不允许静默失败装成功，
// 也不允许权限受限环境里「点了没反应」）。
//
// 两条路径按序降级：
//   ① async Clipboard API —— secure context 下首选（http://127.0.0.1 与桌面壳都满足）；
//   ② execCommand('copy') 降级 —— Clipboard API 缺席 / 被权限策略拒绝 / 窗口失焦
//      被浏览器拒写时，隐藏 textarea + 选区仍可写入（兼容性最广的一条路）。
//
// 返回 boolean 让调用方决定反馈（✓ / 失败提示）：resolve(true)=已写入剪贴板，
// resolve(false)=两条路径都失败——调用方必须如实呈现，不得把 false 当成功。
// 抽成类的目的：让「复制」这个副作用可被替换与单测，而不是散落在渲染代码里。

/** 剪贴板复制器：双路径降级写入，返回值即真实结果（true=已写入 / false=全败）。 */
export class ClipboardCopier {
  /**
   * 写入文本到系统剪贴板。
   * @param text 要写入的文本。
   * @returns true = 至少一条路径确认写入成功；false = 全部失败。
   */
  public static async copy(text: string): Promise<boolean> {
    if (await ClipboardCopier.viaAsyncApi(text)) return true;
    return ClipboardCopier.viaExecCommand(text);
  }

  /**
   * 路径 ①：async Clipboard API。
   * @param text 要写入的文本。
   * @returns 是否写入成功。
   */
  private static async viaAsyncApi(text: string): Promise<boolean> {
    try {
      const nav = navigator as { clipboard?: { writeText(t: string): Promise<void> } } | undefined;
      if (!nav?.clipboard) return false;
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      /* 被拒 / 失焦 / 非安全上下文：落到 execCommand 降级 */
      return false;
    }
  }

  /**
   * 路径 ②：execCommand('copy') 降级。
   * @param text 要写入的文本。
   * @returns 是否写入成功（execCommand 的返回值即写入结果）。
   */
  private static viaExecCommand(text: string): boolean {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      // readonly：防止软键盘弹出 / 内容被输入法改写；fixed + 视口外：不引起页面滚动跳动，
      // 但必须**可聚焦可选中**（display:none 的元素选区会失效，复制会拿到空）。
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      // 保存用户当前选区，复制完恢复（否则页面上的选区会被吞掉）。
      const selection = document.getSelection();
      const saved =
        selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      if (saved !== null && selection !== null) {
        selection.removeAllRanges();
        selection.addRange(saved);
      }
      return ok;
    } catch {
      return false;
    }
  }
}
