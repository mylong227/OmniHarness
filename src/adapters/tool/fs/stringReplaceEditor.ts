/**
 * 字符串替换编辑原语（零依赖，纯逻辑）：`edit` 工具的判定内核。
 *
 * 为什么需要它：本仓原有的「改代码」只有两条路——整文件 `write_file`（重写全文件，token 贵且易丢失无关内容）
 * 与 `apply_patch`（**行号锚定 + 逐字符精确比较**，模型一旦把行号或行尾空白写偏就直接失败）。
 * 实测（2026-09-19 能力盘点，`_audit_tmp/patch_probe.mjs`）6 类常见模型 diff 有 4 类直接失败。
 * 本类补上第三条路：**按内容替换**，模型不必知道行号，只提供「要改哪段/改成什么」。
 *
 * 三级匹配（前一级命中即返回，后者永远只是兜底）：
 * 1. **精确子串**——命中 1 次即替换；`replace_all` 时替换全部；命中多次且未开 `replace_all`
 *    ⇒ **报错并要求补充上下文**（绝不猜改哪一处）；
 * 2. **空白折叠**——把连续空白（缩进 / 行尾空格 / CRLF）折叠为单个空格后再找，覆盖模型最高频的
 *    两类偏差：**缩进层级写错**与**行尾空白差异**；
 * 3. **行号前缀剥离 + 空白折叠**——`read_file` 的带行号输出被模型整段粘进 `old_string` 时，
 *    前缀数字会让前两级必然失配；本级把每行开头的 `123→` / `123:` / `123|` 前缀一并剥掉。
 *    这是「读带行号」与「改要精确」这对组合的**结构性解法**，而不是让模型自己记得去剥。
 *
 * 纪律：任何一处不确定（0 次 / 多次歧义）都**原样返回失败**，绝不做「最接近的那处」这种猜测性改写。
 */
export interface StringReplaceRequest {
  /** 要被替换掉的原文本（不得为空）。 */
  readonly oldText: string;
  /** 替换成的新文本（可为空串＝删除该段）。 */
  readonly newText: string;
  /** 是否替换全部命中（默认 false：要求唯一命中）。 */
  readonly replaceAll?: boolean;
  /** 是否允许模糊匹配（默认 true；显式 false 可强制逐字符精确）。 */
  readonly fuzzy?: boolean;
}

/** 替换结果。 */
export interface StringReplaceOutcome {
  /** 是否成功。 */
  readonly ok: boolean;
  /** 替换后的完整内容（成功时提供）。 */
  readonly content?: string | undefined;
  /** 实际替换处数（成功时提供）。 */
  readonly replacements?: number | undefined;
  /** 命中所用的匹配级别（成功时提供，便于回报与诊断）。 */
  readonly matchKind?: MatchKind | undefined;
  /** 首次替换所在的 1-based 行号（成功时提供，便于工具回报与模型定位）。 */
  readonly line?: number | undefined;
  /** 失败原因（失败时提供）。 */
  readonly error?: string | undefined;
}

/** 匹配级别。 */
export type MatchKind = 'exact' | 'whitespace' | 'line-numbers';

/** 原文中的字符区间 `[start, end)`。 */
type TextRange = readonly [number, number];

/** 归一化后的文本及其到原文的下标映射。 */
interface NormalizedText {
  /** 归一化后的文本。 */
  readonly text: string;
  /** 归一化后第 i 个字符在原文中的下标（长度与 `text` 相同）。 */
  readonly map: readonly number[];
}

/** 单行开头的行号前缀（`  12→` / `12:` / `12|` / `12\t`），最多回看 12 个字符。 */
const LINE_NUMBER_PREFIX = /^[ \t]*\d+[→:|\t][ \t]?/;

/** 按内容替换的编辑内核（无状态，可复用）。 */
export class StringReplaceEditor {
  /** 模糊匹配的降级顺序：先只折叠空白，再叠加行号前缀剥离。 */
  private static readonly FUZZY_LEVELS: readonly {
    readonly kind: MatchKind;
    readonly strip: boolean;
  }[] = [
    { kind: 'whitespace', strip: false },
    { kind: 'line-numbers', strip: true },
  ];

  /**
   * 执行替换。
   *
   * @param original 原文件内容。
   * @param request 替换请求（old/new/replaceAll/fuzzy）。
   * @returns 成功时给出新内容、处数、匹配级别与首行行号；失败时给出可读原因且**不改动任何内容**。
   */
  public replace(original: string, request: StringReplaceRequest): StringReplaceOutcome {
    if (request.oldText === '') {
      return { ok: false, error: 'old_string 不能为空（如需整文件覆盖请改用 write_file）' };
    }
    const replaceAll = request.replaceAll === true;
    const exact = StringReplaceEditor.rangesOf(original, request.oldText);
    if (exact.length > 0 && (replaceAll || exact.length === 1)) {
      return StringReplaceEditor.applyRanges(original, exact, request.newText, 'exact');
    }
    if (exact.length > 1) {
      return { ok: false, error: StringReplaceEditor.ambiguity(exact.length) };
    }
    if (request.fuzzy === false) {
      return { ok: false, error: '未找到 old_string（已禁用模糊匹配，要求逐字符精确命中）' };
    }
    return this.replaceFuzzy(original, request, replaceAll);
  }

  /**
   * 模糊路径：按 {@link StringReplaceEditor.FUZZY_LEVELS} 逐级降级查找。
   *
   * @param original 原文件内容。
   * @param request 替换请求。
   * @param replaceAll 是否替换全部命中。
   * @returns 替换结果；全部级别都未命中时给出结构化失败说明。
   */
  private replaceFuzzy(
    original: string,
    request: StringReplaceRequest,
    replaceAll: boolean,
  ): StringReplaceOutcome {
    for (const level of StringReplaceEditor.FUZZY_LEVELS) {
      const ranges = StringReplaceEditor.fuzzyRanges(original, request.oldText, level.strip);
      if (ranges.length === 0) {
        continue;
      }
      if (ranges.length > 1 && !replaceAll) {
        return { ok: false, error: StringReplaceEditor.ambiguity(ranges.length) };
      }
      return StringReplaceEditor.applyRanges(
        original,
        replaceAll ? ranges : ranges.slice(0, 1),
        request.newText,
        level.kind,
      );
    }
    return {
      ok: false,
      error:
        '未找到 old_string（已尝试空白折叠与行号前缀剥离两级模糊匹配）。' +
        '请用 read_file 复核目标片段的确切内容后重试。',
    };
  }

  /**
   * 精确子串查找（非重叠、自左向右）。
   *
   * @param haystack 原文。
   * @param needle 待查找子串（调用方保证非空）。
   * @returns 命中区间列表（按出现顺序）。
   */
  private static rangesOf(haystack: string, needle: string): readonly TextRange[] {
    const ranges: TextRange[] = [];
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) {
        return ranges;
      }
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
  }

  /**
   * 归一化后的查找，并把命中映射回原文区间。
   *
   * @param original 原文。
   * @param oldText 待查找片段。
   * @param stripLinePrefixes 是否剥掉每行开头的行号前缀。
   * @returns 命中区间列表；归一化后片段为空（纯空白 old_string）时为空数组。
   */
  private static fuzzyRanges(
    original: string,
    oldText: string,
    stripLinePrefixes: boolean,
  ): readonly TextRange[] {
    const source = StringReplaceEditor.withoutTrailingNewline(oldText);
    const needle = StringReplaceEditor.normalize(source, stripLinePrefixes).text;
    if (needle === '') {
      return [];
    }
    const haystack = StringReplaceEditor.normalize(original, stripLinePrefixes);
    const ranges: TextRange[] = [];
    let from = 0;
    for (;;) {
      const at = haystack.text.indexOf(needle, from);
      if (at < 0) {
        return ranges;
      }
      const start = haystack.map[at] ?? 0;
      const end = (haystack.map[at + needle.length - 1] ?? start) + 1;
      ranges.push([start, end]);
      from = at + needle.length;
    }
  }

  /**
   * 剥掉末尾换行（模型整段粘贴时常多带一个换行，而它并不属于内容语义）。
   *
   * @param text 原文本。
   * @returns 末尾换行被剥掉的文本。
   */
  private static withoutTrailingNewline(text: string): string {
    return text.replace(/[\r\n]+$/, '');
  }

  /**
   * 归一化：可选剥离行号前缀 + 把连续空白折叠为单个空格，并记录每个输出字符在原文中的下标。
   *
   * 折叠覆盖空格 / 制表 / 换行 / 回车 / 换页 / 垂直制表；行尾空白与 CRLF 由此一并被容忍。
   *
   * @param text 原文。
   * @param stripLinePrefixes 是否剥掉每行开头的行号前缀。
   * @returns 归一化文本与下标映射（`map.length === text.length`）。
   */
  private static normalize(text: string, stripLinePrefixes: boolean): NormalizedText {
    let out = '';
    const map: number[] = [];
    let pending = false;
    let pendingIndex = -1;
    let atLineStart = stripLinePrefixes;
    let i = 0;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (atLineStart) {
        const skipped = StringReplaceEditor.prefixLength(text, i);
        if (skipped > 0) {
          i += skipped;
          atLineStart = false;
          continue;
        }
        atLineStart = false;
      }
      if (StringReplaceEditor.isWhitespace(ch)) {
        if (ch === '\n') {
          atLineStart = stripLinePrefixes;
        }
        if (out !== '' && !pending) {
          pending = true;
          pendingIndex = i;
        }
        i += 1;
        continue;
      }
      if (pending) {
        out += ' ';
        map.push(pendingIndex);
        pending = false;
      }
      out += ch;
      map.push(i);
      i += 1;
    }
    return { text: out, map };
  }

  /**
   * 该位置是否处于行号前缀中，是则给出前缀长度。
   *
   * @param text 全文。
   * @param index 行首下标。
   * @returns 前缀字符数；无前缀时为 0。
   */
  private static prefixLength(text: string, index: number): number {
    const window = text.slice(index, index + 24);
    const match = LINE_NUMBER_PREFIX.exec(window);
    return match === null ? 0 : match[0].length;
  }

  /**
   * 是否空白字符（折叠对象）。
   *
   * @param ch 单个字符。
   * @returns 属空白时为 true。
   */
  private static isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
  }

  /**
   * 按区间把新文本写回（自右向左 splice，保证下标不失真）。
   *
   * @param original 原文。
   * @param ranges 待替换区间列表。
   * @param newText 新文本。
   * @param matchKind 命中所用的匹配级别。
   * @returns 成功结果（含新内容、处数、匹配级别、首行行号）。
   */
  private static applyRanges(
    original: string,
    ranges: readonly TextRange[],
    newText: string,
    matchKind: MatchKind,
  ): StringReplaceOutcome {
    let content = original;
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      const range = ranges[i];
      if (range === undefined) {
        continue;
      }
      content = content.slice(0, range[0]) + newText + content.slice(range[1]);
    }
    const first = ranges[0];
    return {
      ok: true,
      content,
      replacements: ranges.length,
      matchKind,
      line: first === undefined ? 1 : StringReplaceEditor.lineOf(original, first[0]),
    };
  }

  /**
   * 计算字符下标所在的 1-based 行号。
   *
   * @param text 原文。
   * @param index 字符下标。
   * @returns 行号（从 1 开始）。
   */
  private static lineOf(text: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) {
      if (text.charAt(i) === '\n') {
        line += 1;
      }
    }
    return line;
  }

  /**
   * 构造「多次命中」的可行动错误文案。
   *
   * @param count 命中处数。
   * @returns 错误文案。
   */
  private static ambiguity(count: number): string {
    return (
      `old_string 在文件中出现 ${count} 次，无法确定要改哪一处：` +
      '请在 old_string 中带上相邻的上下文（前后各一到两行）使其唯一，' +
      '或显式设置 replace_all=true 表示全部替换。'
    );
  }
}
