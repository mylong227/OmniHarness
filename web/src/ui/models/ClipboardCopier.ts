// 剪贴板写入：复制失败一律静默（不阻断 UI，也不抛错打断事件处理）。
// 抽成类的目的：让「复制」这个副作用可被替换与单测，而不是散落在渲染代码里。

/** 剪贴板复制器。 */
export class ClipboardCopier {
  /**
   * 写入文本。无剪贴板 API 或写入被拒时 resolve（fail-closed 到「什么都没发生」），
   * 而不是 reject 让调用方必须 catch。
   */
  static copy(text: string): Promise<void> {
    try {
      const nav = navigator as { clipboard?: { writeText(t: string): Promise<void> } } | undefined;
      if (!nav?.clipboard) return Promise.resolve();
      return nav.clipboard.writeText(text).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }
}
