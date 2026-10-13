// 上下文压缩（OMNI_COMPACTION_V1）系统事件的解析（纯逻辑，零 React 依赖）。
//
// 背景（2026-10-13 用户反馈）：压缩游标事件此前在对话流里按 `— 全文 —` 平铺，
// 数千字摘要直接糊满一屏。应收纳成一行简报（游标位置 + 摘要字数），点击再展开摘要全文。
//
// 编码格式与后端 `ContextCompactor.encodeCompactionState` 严格对齐：
//   `OMNI_COMPACTION_V1 upTo=<n> hash=<hex>\n<摘要正文>`
// 解析失败一律返回 null（fail-closed）——调用方回落到普通 sysnote 渲染，绝不猜。

/** 解析结果：游标位置与摘要正文。 */
export interface CompactionNoteParts {
  /** 已压缩到的事件序号（upTo）。 */
  upTo: number;
  /** 压缩前缀指纹（hash）。 */
  hash: string;
  /** 摘要正文（标记行之后的部分）。 */
  summary: string;
}

/** 压缩事件解析器。 */
export class CompactionNote {
  /** 标记行格式（与后端 encodeCompactionState 的正则逐字对齐）。 */
  private static readonly HEADER =
    /^OMNI_COMPACTION_V1 upTo=(\d+) hash=([0-9a-f]+)$/;

  /**
   * 判定并解析一条系统事件文本是否为压缩游标事件。
   * @param content 系统事件 payload.content
   * @returns 解析结果；非压缩事件 / 格式不符 / 摘要为空时为 null
   */
  public static parse(content: string): CompactionNoteParts | null {
    if (!content) return null;
    const nl = content.indexOf('\n');
    if (nl < 0) return null;
    const m = this.HEADER.exec(content.slice(0, nl));
    if (m === null) return null;
    const summary = content.slice(nl + 1);
    if (summary === '') return null;
    return { upTo: Number(m[1]), hash: m[2] ?? '', summary };
  }
}
