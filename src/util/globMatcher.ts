/**
 * 通配符匹配器（零依赖）：`grep` / `glob` 两个编码检索工具的筛选底座。
 *
 * 支持语法（对齐 ripgrep / 常见 glob 子集，不追求完整 POSIX glob 规范）：
 * - `*`：匹配除 `/` 之外的任意字符序列（可空）
 * - `**`：跨目录匹配；`**\/` 可匹配零层目录（`**\/x.ts` 同时命中 `x.ts` 与 `a/b/x.ts`）
 * - `?`：匹配除 `/` 之外的单个字符
 * - `{a,b}`：交替（支持一层嵌套）
 * - `[abc]` / `[a-z]` / `[!abc]`：字符集（`!` 或 `^` 取反）
 *
 * 语义约定：**不含 `/` 的模式按「基名匹配」处理**——`*.ts` 命中任意深度的 `.ts` 文件，
 * 这与 ripgrep `-g '*.ts'` 的直觉一致。路径统一按 POSIX 分隔符比对，
 * Windows 反斜杠在 {@link GlobMatcher.test} 内先归一，避免「同一模式在两类宿主上结论不同」。
 */
export class GlobMatcher {
  /** 归一化后的模式（去 `./` 前缀、反斜杠转 `/`）。 */
  private readonly normalized: string;
  /** 编译后的锚定正则。 */
  private readonly regex: RegExp;

  /**
   * @param pattern 通配符模式（如 `src/**\/*.ts`、`*.{js,ts}`）。
   */
  public constructor(pattern: string) {
    this.normalized = GlobMatcher.normalize(pattern);
    const prefix = this.normalized.includes('/') ? '^' : '^(?:.*/)?';
    this.regex = new RegExp(`${prefix}${GlobMatcher.bodyOf(this.normalized)}$`);
  }

  /**
   * 该路径是否命中模式。
   *
   * @param path 待判定路径（相对或绝对；反斜杠会被归一为 `/`）。
   * @returns 命中时为 true。
   */
  public test(path: string): boolean {
    return this.regex.test(GlobMatcher.normalize(path));
  }

  /**
   * 一次性判定（内部新建匹配器；批量判定请复用实例以免重复编译）。
   *
   * @param pattern 通配符模式。
   * @param path 待判定路径。
   * @returns 命中时为 true。
   */
  public static matches(pattern: string, path: string): boolean {
    return new GlobMatcher(pattern).test(path);
  }

  /**
   * 归一化：反斜杠转 `/`、剥掉开头的 `./`。
   *
   * @param value 原始模式或路径。
   * @returns 归一后的 POSIX 形态。
   */
  private static normalize(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  /**
   * 把模式片段编译为正则体（不含锚点）。
   *
   * @param pattern 归一化后的模式片段。
   * @returns 正则体字符串。
   */
  private static bodyOf(pattern: string): string {
    let out = '';
    let i = 0;
    while (i < pattern.length) {
      const ch = pattern.charAt(i);
      if (ch === '*') {
        if (pattern.charAt(i + 1) === '*') {
          if (pattern.charAt(i + 2) === '/') {
            out += '(?:.*/)?';
            i += 3;
          } else {
            out += '.*';
            i += 2;
          }
        } else {
          out += '[^/]*';
          i += 1;
        }
        continue;
      }
      if (ch === '?') {
        out += '[^/]';
        i += 1;
        continue;
      }
      if (ch === '{') {
        const alt = GlobMatcher.alternation(pattern, i);
        if (alt !== undefined) {
          out += alt.body;
          i = alt.next;
          continue;
        }
      }
      if (ch === '[') {
        const klass = GlobMatcher.charClass(pattern, i);
        if (klass !== undefined) {
          out += klass.body;
          i = klass.next;
          continue;
        }
      }
      out += GlobMatcher.escape(ch);
      i += 1;
    }
    return out;
  }

  /**
   * 解析 `{a,b}` 交替（支持一层嵌套），失败返回 undefined 交回调用方按字面量处理。
   *
   * @param pattern 归一化后的模式。
   * @param start `{` 的下标。
   * @returns 正则体与下一个待处理下标；括号不闭合时为 undefined。
   */
  private static alternation(
    pattern: string,
    start: number,
  ): { readonly body: string; readonly next: number } | undefined {
    const end = GlobMatcher.closingIndex(pattern, start, '{', '}');
    if (end < 0) {
      return undefined;
    }
    const alts = pattern.slice(start + 1, end).split(',');
    const bodies = alts.map((alt) => GlobMatcher.bodyOf(alt));
    return { body: `(?:${bodies.join('|')})`, next: end + 1 };
  }

  /**
   * 解析 `[...]` 字符集，失败返回 undefined 交回调用方按字面量处理。
   *
   * @param pattern 归一化后的模式。
   * @param start `[` 的下标。
   * @returns 正则体与下一个待处理下标；集合不闭合时为 undefined。
   */
  private static charClass(
    pattern: string,
    start: number,
  ): { readonly body: string; readonly next: number } | undefined {
    const end = pattern.indexOf(']', start + 1);
    if (end < 0) {
      return undefined;
    }
    let inner = pattern.slice(start + 1, end);
    let negated = false;
    if (inner.startsWith('!') || inner.startsWith('^')) {
      negated = true;
      inner = inner.slice(1);
    }
    if (inner === '') {
      return undefined;
    }
    return {
      body: `[${negated ? '^' : ''}${inner.replace(/\\/g, '\\\\')}]`,
      next: end + 1,
    };
  }

  /**
   * 找配对闭合符下标（跳过嵌套）。
   *
   * @param pattern 归一化后的模式。
   * @param start 起始下标（`{` 或 `[` 的位置）。
   * @param open 开括号字符。
   * @param close 闭括号字符。
   * @returns 闭合符下标；未闭合返回 -1。
   */
  private static closingIndex(pattern: string, start: number, open: string, close: string): number {
    let depth = 0;
    for (let i = start; i < pattern.length; i += 1) {
      const ch = pattern.charAt(i);
      if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  /**
   * 转义正则元字符。
   *
   * @param ch 单个字符。
   * @returns 可安全放入正则的形态。
   */
  private static escape(ch: string): string {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
