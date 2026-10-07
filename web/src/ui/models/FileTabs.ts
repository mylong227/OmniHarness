// 代码查看器标签页的**纯逻辑**（零 React，可 node 单测）：
// 「打开文件」的标签集合合并（同路径去重 + 后开刷新内容 + 上限淘汰最旧）与关闭后的激活回落。
// SessionController 只做状态搬运，判定规则全部收在这里——规则一旦要改（比如上限数），只动这一处。

import type { FileView } from '../shared.js';

/** 同屏保留的文件标签上限：超过即淘汰最旧的未激活标签（防长会话把标签条挤爆）。 */
const MAX_OPEN_FILES = 8;

/** 关闭标签后的结果：新标签集合 + 应回落激活的文件（null 表示全部关完）。 */
export interface FileTabsCloseResult {
  /** 关闭后的标签集合（保持原顺序）。 */
  readonly list: FileView[];
  /** 应回落到激活态的文件；被关的不是激活文件时，回落到原激活文件。 */
  readonly active: FileView | null;
}

/** 代码查看器标签集合的合并 / 关闭规则（纯静态，无状态）。 */
export class FileTabs {
  /**
   * 合并一次「打开文件」：同路径刷新内容并保持原位，新文件追加在队尾；
   * 超过上限时淘汰**最旧的**标签（激活标签永不淘汰）。
   * @param prev 当前标签集合
   * @param view 刚打开的文件
   * @returns 新标签集合
   */
  public static merge(prev: readonly FileView[], view: FileView): FileView[] {
    const idx = prev.findIndex((f) => f.title === view.title);
    const merged = idx >= 0 ? prev.map((f, i) => (i === idx ? view : f)) : [...prev, view];
    // merge 每次最多新增一个标签；超限即淘汰最旧的**非激活**标签（一次一个即回到上限内）。
    if (merged.length <= MAX_OPEN_FILES) return merged;
    const oldestIdx = merged.findIndex((f) => f.title !== view.title);
    if (oldestIdx < 0) return merged; // 只剩激活文件一个，原样返回兜底。
    return merged.filter((_, i) => i !== oldestIdx);
  }

  /**
   * 关闭一个标签：被关的是激活文件则回落到它的邻居（优先右侧，无则左侧）；全部关完为 null。
   * @param prev 当前标签集合
   * @param title 被关闭的文件路径
   * @param activeTitle 当前激活的文件路径（null 表示当前无激活文件）
   * @returns 新集合与回落文件
   */
  public static close(
    prev: readonly FileView[],
    title: string,
    activeTitle: string | null,
  ): FileTabsCloseResult {
    const idx = prev.findIndex((f) => f.title === title);
    if (idx < 0) return { list: [...prev], active: prev.find((f) => f.title === activeTitle) ?? null };
    const list = prev.filter((f) => f.title !== title);
    if (activeTitle !== title) {
      return { list, active: prev.find((f) => f.title === activeTitle) ?? null };
    }
    const neighbor = list[idx] ?? list[idx - 1] ?? null;
    return { list, active: neighbor };
  }
}
