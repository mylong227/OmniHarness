// @mention 解析：从「光标前的文本」里识别正在输入的 @token，并给出过滤后的候选。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 补全候选上限（超过无意义，用户会继续输入）。 */
const MAX_ITEMS = 8;
/** @token 必须在行首或空白之后，且不含空白与 @。 */
const MENTION_RE = /(^|\s)@([^\s@]*)$/;

/** 解析出的 @token 位置与查询词。 */
export interface MentionToken {
  /** `@` 字符在整段文本中的下标。 */
  start: number;
  /** 已输入的查询词（不含 @）。 */
  query: string;
}

/** @mention 解析器。 */
export class MentionResolver {
  /**
   * 从光标前文本解析 @token；未命中返回 null。
   * start 用「光标位置 - 查询词长度 - 1」反推，避免依赖正则捕获组的下标。
   */
  static parse(textBeforeCaret: string, caret: number): MentionToken | null {
    const m = MENTION_RE.exec(textBeforeCaret);
    if (!m) return null;
    const query = m[2] ?? '';
    return { start: caret - query.length - 1, query };
  }

  /** 按查询词过滤候选路径（大小写无关，子串匹配），并截断到上限。 */
  static filter(paths: readonly string[], query: string): string[] {
    const q = query.toLowerCase();
    return paths.filter((p) => p.toLowerCase().includes(q)).slice(0, MAX_ITEMS);
  }

  /** 在环形列表里移动选中下标（+1 下移 / -1 上移），空列表一律 0。 */
  static move(idx: number, count: number, delta: number): number {
    if (count <= 0) return 0;
    return (idx + delta + count) % count;
  }
}
