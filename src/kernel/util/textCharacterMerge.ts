/**
 * 字符级三方合并（行级 diff3 在同一行冲突时的**细化**）。
 *
 * 行级合并把"同一行"当成一个不可分单元；但真实冲突常常是：
 *
 * ```text
 * base:   const value = 1;
 * ours:   const value = 2;        // 改数字
 * theirs: const value = 1; // note  // 同一行加注释
 * ```
 *
 * 两者改的是同一行的**不同字符区间**，字符级 LCS 后区间不相交 ⇒ 可以合并。
 * 本类只负责"冲突片段"的细化，不替代行级合并；字符区间相交/结果不同仍然冲突。
 *
 * 规模：按 UTF-16 code unit 计；超过 `MAX_CELLS` 直接放弃，回落到行级冲突。
 *
 * @maturity L2 — 真实实现字符级 LCS + 区间合并；未做 Unicode 组合字符的 grapheme 对齐
 * @maturityEvidence tests/unit/textCharacterMerge.test.ts
 */
export interface CharacterMergeResult {
  /** 是否干净合并（无冲突）。 */
  readonly ok: boolean;
  /** 合并结果（仅 ok=true 时有意义）。 */
  readonly content: string;
}

/** 单个字符级编辑段。 */
interface CharHunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly otherStart: number;
  readonly otherEnd: number;
}

/** 字符级三方合并器（无状态）。 */
export class TextCharacterMerge {
  /** 字符级 LCS 矩阵最大单元数（超过即放弃，避免长行把内存打满）。 */
  private static readonly MAX_CELLS = 400_000;

  /**
   * 合并同一冲突片段的字符级改动。
   * @param base 共同祖先片段。
   * @param ours 我方片段。
   * @param theirs 对方片段。
   * @returns 干净结果或 `ok:false`（调用方保持行级冲突）。
   */
  public static merge(base: string, ours: string, theirs: string): CharacterMergeResult {
    if (ours === theirs) return { ok: true, content: ours };
    if (base === ours) return { ok: true, content: theirs };
    if (base === theirs) return { ok: true, content: ours };
    const baseUnits = [...base];
    const oursUnits = [...ours];
    const theirsUnits = [...theirs];
    const cells = (baseUnits.length + 1) * (Math.max(oursUnits.length, theirsUnits.length) + 1);
    if (cells > TextCharacterMerge.MAX_CELLS) return { ok: false, content: '' };
    const oursHunks = TextCharacterMerge.diff(baseUnits, oursUnits);
    const theirsHunks = TextCharacterMerge.diff(baseUnits, theirsUnits);
    const merged = TextCharacterMerge.mergeHunks(
      baseUnits,
      oursUnits,
      theirsUnits,
      oursHunks,
      theirsHunks,
    );
    return merged;
  }

  /**
   * 字符级 LCS 差分。
   * @param base base 单元。
   * @param other 目标单元。
   * @returns 编辑段。
   */
  private static diff(base: readonly string[], other: readonly string[]): CharHunk[] {
    const cols = other.length + 1;
    const dp = new Uint32Array((base.length + 1) * cols);
    for (let i = base.length - 1; i >= 0; i -= 1) {
      for (let j = other.length - 1; j >= 0; j -= 1) {
        const at = i * cols + j;
        dp[at] =
          base[i] === other[j]
            ? (dp[(i + 1) * cols + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * cols + j] ?? 0, dp[i * cols + j + 1] ?? 0);
      }
    }
    const hunks: CharHunk[] = [];
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
   * 合并字符级编辑段；区间相交且结果不同即冲突。
   * @param base base 单元。
   * @param ours 我方单元。
   * @param theirs 对方单元。
   * @param oursHunks 我方编辑段。
   * @param theirsHunks 对方编辑段。
   * @returns 合并结果。
   */
  private static mergeHunks(
    base: readonly string[],
    ours: readonly string[],
    theirs: readonly string[],
    oursHunks: readonly CharHunk[],
    theirsHunks: readonly CharHunk[],
  ): CharacterMergeResult {
    const all = [
      ...oursHunks.map((h) => ({ ...h, side: 'ours' as const })),
      ...theirsHunks.map((h) => ({ ...h, side: 'theirs' as const })),
    ].sort(
      (a, b) =>
        a.baseStart - b.baseStart ||
        a.baseEnd - b.baseEnd ||
        (a.side === 'ours' ? -1 : 1) - (b.side === 'ours' ? -1 : 1),
    );
    if (all.length === 0) return { ok: true, content: base.join('') };
    const clusters: (typeof all)[] = [];
    for (const hunk of all) {
      const last = clusters[clusters.length - 1];
      if (last !== undefined && last.some((x) => TextCharacterMerge.overlaps(x, hunk))) {
        last.push(hunk);
      } else {
        clusters.push([hunk]);
      }
    }
    const out: string[] = [];
    let cursor = 0;
    for (const cluster of clusters) {
      const start = Math.min(...cluster.map((h) => h.baseStart));
      const end = Math.max(...cluster.map((h) => h.baseEnd));
      if (start < cursor) return { ok: false, content: '' };
      const oursText = TextCharacterMerge.apply(
        base,
        start,
        end,
        cluster.filter((h) => h.side === 'ours'),
        ours,
      );
      const theirsText = TextCharacterMerge.apply(
        base,
        start,
        end,
        cluster.filter((h) => h.side === 'theirs'),
        theirs,
      );
      const hasOurs = cluster.some((h) => h.side === 'ours');
      const hasTheirs = cluster.some((h) => h.side === 'theirs');
      if (hasOurs && hasTheirs && oursText !== theirsText) return { ok: false, content: '' };
      out.push(...base.slice(cursor, start));
      out.push(...(hasOurs ? oursText : theirsText));
      cursor = end;
    }
    out.push(...base.slice(cursor));
    return { ok: true, content: out.join('') };
  }

  /**
   * 把某侧编辑段应用到 base 区间。
   * @param base base 单元。
   * @param start 起点。
   * @param end 终点。
   * @param hunks 该侧编辑段。
   * @param other 该侧单元。
   * @returns 结果单元。
   */
  private static apply(
    base: readonly string[],
    start: number,
    end: number,
    hunks: readonly (CharHunk & { readonly side: 'ours' | 'theirs' })[],
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
   * 区间是否相交（同一点插入算相交；边界相接不算）。
   * @param a 编辑段。
   * @param b 编辑段。
   * @returns 相交 true。
   */
  private static overlaps(
    a: CharHunk & { readonly side: 'ours' | 'theirs' },
    b: CharHunk & { readonly side: 'ours' | 'theirs' },
  ): boolean {
    const aInsert = a.baseStart === a.baseEnd;
    const bInsert = b.baseStart === b.baseEnd;
    if (aInsert && bInsert) return a.baseStart === b.baseStart;
    if (aInsert) return b.baseStart < a.baseStart && a.baseStart < b.baseEnd;
    if (bInsert) return a.baseStart < b.baseStart && b.baseStart < a.baseEnd;
    return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
  }
}
