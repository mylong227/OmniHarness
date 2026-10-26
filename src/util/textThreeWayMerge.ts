/**
 * 行级**三方合并**（diff3）：`base + ours + theirs` → 干净结果或冲突区间。
 *
 * ## 为什么需要它（本轮数学调研的直接落地）
 *
 * 锚点替换只能回答「`old_string` 还在不在」；它处理不了「双方都基于同一份 base 做了
 * **不同位置**的完整改写」。三方合并的数学形态是：
 *
 * 1. 分别求 `base → ours`、`base → theirs` 的行级编辑脚本（LCS 差分）；
 * 2. 按 base 区间合并两组编辑：**区间不相交 ⇒ 两个改动可交换**，直接叠加；
 * 3. 区间相交且两侧结果不同 ⇒ **冲突**（不猜、不覆盖）。
 *
 * 本实现是**行级**、确定性、无第三方依赖；不做字符级合并（字符级会把「同一行不同位置」
 * 也合并，容易生成语义上不成立的内容）。超过规模上限时返回 `too-large`，调用方退回
 * 「拒绝并重读」的保守路径——**绝不为了合并而把大文件整读两遍**。
 *
 * @maturity L2 — 真实实现 LCS 差分 + 区间合并；与 GNU diff3 的边界排序未做逐例对照
 * @maturityEvidence tests/unit/textThreeWayMerge.test.ts
 */

/** 合并冲突（base 行号 0 起；对外文案时转 1 起）。 */
export interface TextMergeConflict {
  /** 冲突在 base 中的起始行（0 起，含）。 */
  readonly baseStart: number;
  /** 冲突在 base 中的结束行（0 起，不含）。 */
  readonly baseEnd: number;
  /** 我方在该区间的结果（截断后的可读片段）。 */
  readonly ours: string;
  /** 对方在该区间的结果（截断后的可读片段）。 */
  readonly theirs: string;
}

/** 合并结果。 */
export type TextMergeResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason: 'conflict' | 'too-large';
      readonly conflicts: readonly TextMergeConflict[];
    };

/** 单个行级编辑段：base[start:end] 被 other[otherStart:otherEnd] 替换。 */
interface LineHunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly otherStart: number;
  readonly otherEnd: number;
}

/** 带来源标记的编辑段。 */
interface TaggedHunk extends LineHunk {
  readonly side: 'ours' | 'theirs';
}

/** 三方合并器（无状态）。 */
export class TextThreeWayMerge {
  /** 差分矩阵最大单元数（超出即放弃合并，避免 3000×3000 的矩阵把内存打满）。 */
  private static readonly MAX_CELLS = 2_000_000;

  /** 一次最多报告多少个冲突区间（多到一定程度重读比逐条看更快）。 */
  private static readonly MAX_CONFLICTS = 8;

  /** 冲突片段最多回显多少字符。 */
  private static readonly MAX_SNIPPET_CHARS = 600;

  /**
   * 三方合并。
   * @param base 共同祖先全文。
   * @param ours 我方全文。
   * @param theirs 对方（磁盘最新）全文。
   * @returns 干净结果或冲突/超限原因。
   */
  public static merge(base: string, ours: string, theirs: string): TextMergeResult {
    if (ours === theirs) return { ok: true, content: ours };
    if (base === ours) return { ok: true, content: theirs };
    if (base === theirs) return { ok: true, content: ours };
    const baseLines = TextThreeWayMerge.linesOf(base);
    const oursLines = TextThreeWayMerge.linesOf(ours);
    const theirsLines = TextThreeWayMerge.linesOf(theirs);
    const cells = (baseLines.length + 1) * (Math.max(oursLines.length, theirsLines.length) + 1);
    if (cells > TextThreeWayMerge.MAX_CELLS) {
      return { ok: false, reason: 'too-large', conflicts: [] };
    }
    const oursHunks = TextThreeWayMerge.diff(baseLines, oursLines);
    const theirsHunks = TextThreeWayMerge.diff(baseLines, theirsLines);
    const merged = TextThreeWayMerge.mergeHunks(
      baseLines,
      oursLines,
      theirsLines,
      oursHunks,
      theirsHunks,
    );
    if (!merged.ok) return merged;
    return { ok: true, content: merged.lines.join('\n') };
  }

  /**
   * 按行切分（保留末尾换行语义：`"a\n"` → `["a",""]`，join 后仍是 `"a\n"`）。
   * @param text 文本。
   * @returns 行数组。
   */
  private static linesOf(text: string): string[] {
    return text.split('\n');
  }

  /**
   * 行级 LCS 差分：返回 base → other 的编辑段（按 base 起点升序）。
   * @param base base 行。
   * @param other 目标行。
   * @returns 编辑段。
   */
  private static diff(base: readonly string[], other: readonly string[]): LineHunk[] {
    const rows = base.length + 1;
    const cols = other.length + 1;
    const dp = new Uint32Array(rows * cols);
    for (let i = base.length - 1; i >= 0; i -= 1) {
      for (let j = other.length - 1; j >= 0; j -= 1) {
        const index = i * cols + j;
        dp[index] =
          base[i] === other[j]
            ? (dp[(i + 1) * cols + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * cols + j] ?? 0, dp[i * cols + j + 1] ?? 0);
      }
    }
    const hunks: LineHunk[] = [];
    let i = 0;
    let j = 0;
    let start = -1;
    let baseEnd = -1;
    let otherStart = -1;
    let otherEnd = -1;
    const flush = (): void => {
      if (start < 0) return;
      hunks.push({ baseStart: start, baseEnd, otherStart, otherEnd });
      start = -1;
    };
    while (i < base.length || j < other.length) {
      if (i < base.length && j < other.length && base[i] === other[j]) {
        flush();
        i += 1;
        j += 1;
        continue;
      }
      if (start < 0) {
        start = i;
        baseEnd = i;
        otherStart = j;
        otherEnd = j;
      }
      if (
        i < base.length &&
        (j >= other.length || (dp[(i + 1) * cols + j] ?? 0) >= (dp[i * cols + j + 1] ?? 0))
      ) {
        i += 1;
        baseEnd = i;
      } else {
        j += 1;
        otherEnd = j;
      }
    }
    flush();
    return hunks;
  }

  /**
   * 合并两侧编辑段：不相交的直接叠加，相交且结果不同即冲突。
   * @param base base 行。
   * @param oursLines 我方行。
   * @param theirsLines 对方行。
   * @param oursHunks 我方编辑段。
   * @param theirsHunks 对方编辑段。
   * @returns 合并后的行或冲突。
   */
  private static mergeHunks(
    base: readonly string[],
    oursLines: readonly string[],
    theirsLines: readonly string[],
    oursHunks: readonly LineHunk[],
    theirsHunks: readonly LineHunk[],
  ): { readonly ok: true; readonly lines: string[] } | Extract<TextMergeResult, { ok: false }> {
    const all: TaggedHunk[] = [
      ...oursHunks.map((hunk) => ({ ...hunk, side: 'ours' as const })),
      ...theirsHunks.map((hunk) => ({ ...hunk, side: 'theirs' as const })),
    ].sort(
      (a, b) =>
        a.baseStart - b.baseStart ||
        a.baseEnd - b.baseEnd ||
        (a.side === 'ours' ? -1 : 1) - (b.side === 'ours' ? -1 : 1),
    );
    if (all.length === 0) return { ok: true, lines: [...base] };
    const clusters: TaggedHunk[][] = [];
    for (const hunk of all) {
      const last = clusters[clusters.length - 1];
      if (
        last !== undefined &&
        last.some((existing) => TextThreeWayMerge.overlaps(existing, hunk))
      ) {
        last.push(hunk);
      } else {
        clusters.push([hunk]);
      }
    }
    const out: string[] = [];
    let cursor = 0;
    const conflicts: TextMergeConflict[] = [];
    for (const cluster of clusters) {
      const start = Math.min(...cluster.map((hunk) => hunk.baseStart));
      const end = Math.max(...cluster.map((hunk) => hunk.baseEnd));
      if (start < cursor) {
        // 理论上不可达（排序 + 相交合并）；保底当冲突，绝不输出错位内容。
        conflicts.push({
          baseStart: start,
          baseEnd: end,
          ours: '（区间重叠）',
          theirs: '（区间重叠）',
        });
        continue;
      }
      const ours = TextThreeWayMerge.apply(
        base,
        start,
        end,
        cluster.filter((hunk) => hunk.side === 'ours'),
        oursLines,
      );
      const theirs = TextThreeWayMerge.apply(
        base,
        start,
        end,
        cluster.filter((hunk) => hunk.side === 'theirs'),
        theirsLines,
      );
      const hasOurs = cluster.some((hunk) => hunk.side === 'ours');
      const hasTheirs = cluster.some((hunk) => hunk.side === 'theirs');
      if (hasOurs && hasTheirs && ours.join('\n') !== theirs.join('\n')) {
        if (conflicts.length < TextThreeWayMerge.MAX_CONFLICTS) {
          conflicts.push({
            baseStart: start,
            baseEnd: end,
            ours: TextThreeWayMerge.snippet(ours),
            theirs: TextThreeWayMerge.snippet(theirs),
          });
        }
        continue;
      }
      out.push(...base.slice(cursor, start));
      out.push(...(hasOurs ? ours : theirs));
      cursor = end;
    }
    if (conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts };
    out.push(...base.slice(cursor));
    return { ok: true, lines: out };
  }

  /**
   * 把某侧在 [start,end) 内的编辑段应用到 base。
   * @param base base 行。
   * @param start 区间起点。
   * @param end 区间终点。
   * @param hunks 该侧编辑段。
   * @param other 该侧行。
   * @returns 结果行。
   */
  private static apply(
    base: readonly string[],
    start: number,
    end: number,
    hunks: readonly TaggedHunk[],
    other: readonly string[],
  ): string[] {
    const out: string[] = [];
    let cursor = start;
    for (const hunk of hunks) {
      if (hunk.baseStart >= cursor) out.push(...base.slice(cursor, hunk.baseStart));
      out.push(...other.slice(hunk.otherStart, hunk.otherEnd));
      cursor = Math.max(cursor, hunk.baseEnd);
    }
    out.push(...base.slice(cursor, end));
    return out;
  }

  /**
   * 两个编辑段是否相交（含「同一点的插入」；边界相接不算相交，可分别应用）。
   * @param a 编辑段。
   * @param b 编辑段。
   * @returns 相交返回 true。
   */
  private static overlaps(a: TaggedHunk, b: TaggedHunk): boolean {
    const aInsert = a.baseStart === a.baseEnd;
    const bInsert = b.baseStart === b.baseEnd;
    if (aInsert && bInsert) return a.baseStart === b.baseStart;
    if (aInsert) return b.baseStart < a.baseStart && a.baseStart < b.baseEnd;
    if (bInsert) return a.baseStart < b.baseStart && b.baseStart < a.baseEnd;
    return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
  }

  /**
   * 生成冲突片段（有界）。
   * @param lines 行。
   * @returns 可读片段。
   */
  private static snippet(lines: readonly string[]): string {
    const text = lines.join('\n');
    return text.length <= TextThreeWayMerge.MAX_SNIPPET_CHARS
      ? text
      : `${text.slice(0, TextThreeWayMerge.MAX_SNIPPET_CHARS)}…`;
  }
}
