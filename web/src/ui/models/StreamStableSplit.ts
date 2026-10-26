/**
 * 流式正文的「稳定段 / 尾部」切分（W1）。
 *
 * 目标：流式期只重渲染**已经闭合的块**，尾部半截文本用纯文本渲染；这样每次 delta 不再重跑
 * 整篇 markdown-it/hljs。切分点取**最后一个不在 fenced code 内的空行之前**：
 * - stable 不含空行分隔符（由尾部原样保留），因此 `stableText + tail` 与原文逐字节一致；
 * - 代码围栏内的空行不切，避免把半个代码块渲染成 Markdown。
 */
export class StreamStableSplit {
  /**
   * 切分文本。
   * @param text 当前累计流式文本。
   * @returns `stable`（可安全 Markdown 渲染的已闭合前缀）与 `tail`（纯文本尾部）。
   */
  public static split(text: string): { stable: string; tail: string } {
    if (text === '') return { stable: '', tail: '' };
    let fence: string | null = null;
    let offset = 0;
    let boundary = -1;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      const marker = trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : null;
      if (marker !== null) {
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
      } else if (fence === null && trimmed === '' && offset > 0) {
        // 空行前的换行属于分隔符：stable 到此为止，tail 从换行开始（保留 \n\n）。
        boundary = offset - 1;
      }
      offset += line.length + 1;
    }
    if (boundary <= 0) return { stable: '', tail: text };
    return { stable: text.slice(0, boundary), tail: text.slice(boundary) };
  }
}
