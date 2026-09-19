/**
 * Unified diff 应用器（纯逻辑，零依赖，失败不改动任何内容）。
 *
 * 为什么重写（2026-09-19 能力盘点，`_audit_tmp/patch_probe.mjs` 实测）：原实现是
 * **行号锚定 + 逐字符精确比较，且只取首个 `+++` 头**——6 类常见模型 diff 有 4 类直接失败：
 * 行号写偏、行尾空白差异、**多文件补丁**（后几个文件被静默丢弃）、`@@ -0,0`（负下标歪打正着）。
 * 而「模型把 diff 写得完全精确」本身就不是可依赖的前提。
 *
 * 本实现的三层容错（由严到宽，**只在更严的一层失败后才降级**，绝不改变精确补丁的行为）：
 * 1. `exact`：逐字符相等；
 * 2. `trailing`：忽略行尾空白（`\r` / 尾随空格）；
 * 3. `numbered`：在第 2 层基础上再剥掉每行开头的行号前缀（`  41→`），
 *    直接对治「模型把 `read_file` 的带行号输出整段贴进补丁上下文」这一高频形态。
 *
 * 并且每一层都在**声明位置附近做双向偏移搜索**（默认 ±200 行），因此行号写偏不再等于失败；
 * 命中位置优先取离声明位置最近者，保证结果确定。
 *
 * 多文件：{@link PatchApplier.parseFiles} 返回**全部** `+++` 段，
 * {@link PatchApplier.applyMany} 要么全部成功、要么整体失败（原子性由调用方落盘时保证）。
 */
/** 补丁 hunk。 */
export interface Hunk {
  /** 旧文件起始行号（1 起；`@@ -0,0` 新文件场景为 0）。 */
  readonly oldStart: number;
  /** 旧文件中被声明替换的行数（仅用于报错定位；实际以 hunk 体为准）。 */
  readonly oldCount: number;
  /** hunk 体行（含前缀字符；构造期原地追加，构造完成后不再变更）。 */
  lines: string[];
}

/** 单个文件的补丁段。 */
export interface FilePatch {
  /** 目标文件路径（已剥 `a/` `b/` 前缀）；`/dev/null` 目标为空串。 */
  readonly targetFile: string;
  /** 该文件的 hunk 列表。 */
  readonly hunks: readonly Hunk[];
}

/** 补丁解析结果（多文件）。 */
export type PatchParseResult =
  | { readonly ok: true; readonly files: readonly FilePatch[] }
  | { readonly ok: false; readonly error: string };

/** 单文件应用结果（向后兼容 {@link PatchApplier.apply}）。 */
export interface PatchApplierResult {
  /** 应用是否成功。 */
  readonly ok: boolean;
  /** 补丁目标文件（解析成功时提供）。 */
  readonly targetFile?: string | undefined;
  /** 应用后的新文件内容（成功时提供）。 */
  readonly newContent?: string | undefined;
  /** 失败原因（失败时提供）。 */
  readonly error?: string | undefined;
}

/** 多文件应用结果。 */
export type MultiApplyResult =
  | {
      readonly ok: true;
      readonly outputs: readonly { readonly targetFile: string; readonly content: string }[];
    }
  | { readonly ok: false; readonly error: string };

/** 上下文比较级别（数字越大越宽松）。 */
type MatchLevel = 0 | 1 | 2;

/** 单文件行数上限（防超大文件把 ±偏移搜索拖成线性爆炸）。 */
const SEARCH_WINDOW_LINES = 200;

/** 行号前缀（`  41→` / `41:` / `41|` / `41\t`）。 */
const LINE_NUMBER_PREFIX = /^[ \t]*\d+[→:|\t][ \t]?/;

/**
 * 统一 diff 应用器：解析 + 应用（纯逻辑，失败时不产生任何新内容）。
 */
export class PatchApplier {
  /** 由严到宽的匹配级别顺序。 */
  private static readonly LEVELS: readonly MatchLevel[] = [0, 1, 2];

  /**
   * 应用补丁到**单个**文件（向后兼容入口：多文件补丁时只应用第一段）。
   *
   * @param original 原文件内容。
   * @param patch unified diff 补丁文本。
   * @returns 应用结果：成功附目标文件与新内容；任一 hunk 失败即整体失败且不改动原内容。
   */
  public apply(original: string, patch: string): PatchApplierResult {
    const parsed = this.parse(patch);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const applied = this.applyHunks(original, parsed.hunks);
    if (!applied.ok) {
      return { ok: false, error: applied.error };
    }
    return { ok: true, targetFile: parsed.targetFile, newContent: applied.content };
  }

  /**
   * 解析补丁的第一段（向后兼容入口，供调用方先校验）。
   *
   * @param patch unified diff 补丁文本。
   * @returns 解析成功附目标文件与 hunk 列表；缺少文件头或有效 hunk 时附错误。
   */
  public parse(
    patch: string,
  ): { ok: true; targetFile: string; hunks: readonly Hunk[] } | { ok: false; error: string } {
    const parsed = this.parseFiles(patch);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const first = parsed.files[0];
    if (first === undefined) {
      return { ok: false, error: 'patch 缺少 +++ 目标文件头' };
    }
    return { ok: true, targetFile: first.targetFile, hunks: first.hunks };
  }

  /**
   * 解析补丁的**全部**文件段（多文件补丁的关键修复点）。
   *
   * @param patch unified diff 补丁文本。
   * @returns 解析成功附全部文件段；无 `+++` 头、有文件段无 hunk、或目标为 `/dev/null` 时附错误。
   */
  public parseFiles(patch: string): PatchParseResult {
    const files = this.splitFilePatches(patch);
    if (files.length === 0) {
      return { ok: false, error: 'patch 缺少 +++ 目标文件头' };
    }
    for (const file of files) {
      if (file.targetFile === '') {
        return { ok: false, error: 'patch 目标为 /dev/null（删除文件）尚未支持，请改用 shell' };
      }
      if (file.hunks.length === 0) {
        return { ok: false, error: `patch 中 ${file.targetFile} 缺少有效 @@ hunk` };
      }
    }
    return { ok: true, files };
  }

  /**
   * 应用到多个文件（`originals` 缺失的路径按空文件处理＝新建）。
   *
   * @param originals 目标路径 → 原内容 的映射（调用方负责读盘与路径校验）。
   * @param patch unified diff 补丁文本。
   * @returns 全部成功时给出每个目标的新内容；任一段失败则整体失败（调用方据此保证不落盘）。
   */
  public applyMany(originals: ReadonlyMap<string, string>, patch: string): MultiApplyResult {
    const parsed = this.parseFiles(patch);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const outputs: { targetFile: string; content: string }[] = [];
    for (const file of parsed.files) {
      const applied = this.applyHunks(originals.get(file.targetFile) ?? '', file.hunks);
      if (!applied.ok) {
        return { ok: false, error: `${file.targetFile}: ${applied.error ?? '应用失败'}` };
      }
      outputs.push({ targetFile: file.targetFile, content: applied.content });
    }
    return { ok: true, outputs };
  }

  /**
   * 把补丁文本切成文件段（每个 `+++` 头开一段，hunk 归属其所在的段）。
   *
   * @param patch 补丁文本。
   * @returns 文件段列表（保持补丁内顺序）。
   */
  private splitFilePatches(patch: string): FilePatch[] {
    const files: FilePatch[] = [];
    let hunks: Hunk[] | undefined;
    let current: Hunk | undefined;
    const lines = patch.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.startsWith('+++ ')) {
        hunks = [];
        files.push({ targetFile: PatchApplier.targetFileOf(line), hunks });
        current = undefined;
        continue;
      }
      // 文件段边界：`--- ` 紧跟 `+++ ` 时，它是**下一段**的旧文件头，必须结束上一段的 hunk。
      // 原实现只认 `+++ `，于是该行落进上一段 hunk，又被 `-` 开头的判据当成删除行
      // ⇒ 旧侧上下文凭空多一行 ⇒ 多文件补丁的第一段必然「上下文不匹配」而整体失败。
      if (line.startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ')) {
        current = undefined;
        continue;
      }
      if (hunks === undefined) {
        continue;
      }
      if (line.startsWith('@@ ')) {
        const header = PatchApplier.parseHeader(line);
        if (header === undefined) {
          continue;
        }
        current = { oldStart: header.oldStart, oldCount: header.oldCount, lines: [] };
        hunks.push(current);
        continue;
      }
      if (current !== undefined && line !== '') {
        current.lines.push(line);
      }
    }
    return files;
  }

  /**
   * 提取 `+++` 行中的目标文件路径。
   *
   * @param line `+++ b/path` 形式的行。
   * @returns 剥掉 `a/` `b/` 前缀与时间戳后的路径；`/dev/null` 返回空串。
   */
  private static targetFileOf(line: string): string {
    const raw = line.slice(4).split('\t')[0] ?? '';
    const path = raw.trim().replace(/^[ab]\//, '');
    return path === '/dev/null' ? '' : path;
  }

  /**
   * 解析 hunk 头。
   *
   * @param line `@@ -oldStart[,oldCount] +newStart[,newCount] @@` 格式的头行。
   * @returns 旧文件起始行与行数；格式非法为 undefined。
   */
  private static parseHeader(line: string): { oldStart: number; oldCount: number } | undefined {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (match === null) {
      return undefined;
    }
    return { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1) };
  }

  /**
   * 依次应用一个文件的全部 hunk。
   *
   * @param original 原文件内容。
   * @param hunks 该文件的 hunk 列表。
   * @returns 成功附新内容；失败附可读原因（含行号与已尝试的容错级别）。
   */
  private applyHunks(
    original: string,
    hunks: readonly Hunk[],
  ): { ok: true; content: string } | { ok: false; error: string } {
    // 空文件用空行数组表示：`split('\n')` 会产生一个空串元素，会让 `@@ -0,0` 新文件补丁多出空行。
    const lines = original === '' ? [] : original.split('\n');
    let offset = 0;
    for (const hunk of hunks) {
      const applied = this.applyHunk(lines, hunk, offset);
      if (!applied.ok) {
        return { ok: false, error: applied.error ?? 'hunk 应用失败' };
      }
      offset = applied.offset;
    }
    return { ok: true, content: lines.join('\n') };
  }

  /**
   * 应用单个 hunk：先按声明的（含累计偏移）位置找，找不到则在 ±窗口内做双向偏移搜索，逐级放宽比较。
   *
   * @param lines 当前文件行数组（原地修改）。
   * @param hunk 待应用的 hunk。
   * @param offset 前序 hunk 累计的行数偏移。
   * @returns 应用结果：成功附累计偏移；上下文无法匹配时失败并附错误。
   */
  private applyHunk(
    lines: string[],
    hunk: Hunk,
    offset: number,
  ): { ok: boolean; offset: number; error?: string } {
    const expected = Math.max(0, hunk.oldStart - 1 + offset);
    const oldLines = PatchApplier.oldSideOf(hunk);
    const start = this.findStart(lines, oldLines, expected);
    if (start === undefined) {
      return {
        ok: false,
        offset,
        error:
          `第 ${expected + 1} 行附近上下文不匹配（已尝试 ±${SEARCH_WINDOW_LINES} 行偏移，` +
          '并容忍行尾空白与行号前缀差异）。请先用 read_file 复核目标区域。',
      };
    }
    const replacement = PatchApplier.buildReplacement(lines, hunk, start);
    lines.splice(start, oldLines.length, ...replacement);
    return { ok: true, offset: offset + (replacement.length - oldLines.length) };
  }

  /**
   * 组装替换后的行：**上下文行一律取文件里的真实内容**（而不是补丁里的副本）。
   *
   * 为什么要取真实内容：容错匹配允许上下文行带着行尾空白或 `read_file` 的行号前缀，
   * 若把这些副本原样写回，就等于用「脏副本」覆盖了本来正确的代码——
   * 「容错匹配」会变成「污染写回」。上下文行的语义本就是「这些行不变」，
   * 因此正确做法是把文件里的原行放回去。
   *
   * @param lines 当前文件行数组。
   * @param hunk 待应用的 hunk。
   * @param start 已定位的落点（0 起下标）。
   * @returns 替换用的行数组。
   */
  private static buildReplacement(lines: readonly string[], hunk: Hunk, start: number): string[] {
    const replacement: string[] = [];
    let cursor = start;
    for (const line of hunk.lines) {
      const op = line.charAt(0);
      if (op === ' ') {
        replacement.push(lines[cursor] ?? line.slice(1));
        cursor += 1;
      } else if (op === '-') {
        cursor += 1;
      } else if (op === '+') {
        replacement.push(line.slice(1));
      }
    }
    return replacement;
  }

  /**
   * 定位 hunk 的落点。
   *
   * 搜索顺序：由严到宽的比较级别（精确 → 行尾容忍 → 行号前缀容忍），
   * 每一级内按「离声明位置最近」优先（先试声明位置，再 ±1、±2 …）。
   *
   * @param lines 当前文件行数组。
   * @param oldLines hunk 的旧侧行（上下文 + 删除）。
   * @param expected 声明位置（0 起下标）。
   * @returns 命中下标；窗口内无命中为 undefined。
   */
  private findStart(
    lines: readonly string[],
    oldLines: readonly string[],
    expected: number,
  ): number | undefined {
    if (oldLines.length === 0) {
      return Math.min(expected, lines.length);
    }
    for (const level of PatchApplier.LEVELS) {
      const hit = this.searchAt(lines, oldLines, expected, level);
      if (hit !== undefined) {
        return hit;
      }
    }
    return undefined;
  }

  /**
   * 在指定比较级别下做双向偏移搜索。
   *
   * @param lines 当前文件行数组。
   * @param oldLines hunk 的旧侧行。
   * @param expected 声明位置（0 起下标）。
   * @param level 比较级别。
   * @returns 命中下标；未命中为 undefined。
   */
  private searchAt(
    lines: readonly string[],
    oldLines: readonly string[],
    expected: number,
    level: MatchLevel,
  ): number | undefined {
    for (let distance = 0; distance <= SEARCH_WINDOW_LINES; distance += 1) {
      const candidates = distance === 0 ? [expected] : [expected - distance, expected + distance];
      for (const start of candidates) {
        if (start < 0 || start + oldLines.length > lines.length) {
          continue;
        }
        if (PatchApplier.matchesAt(lines, oldLines, start, level)) {
          return start;
        }
      }
    }
    return undefined;
  }

  /**
   * 该位置是否整段匹配。
   *
   * @param lines 当前文件行数组。
   * @param oldLines hunk 的旧侧行。
   * @param start 候选起点（0 起）。
   * @param level 比较级别。
   * @returns 全部行在该级别下相等时为 true。
   */
  private static matchesAt(
    lines: readonly string[],
    oldLines: readonly string[],
    start: number,
    level: MatchLevel,
  ): boolean {
    for (let i = 0; i < oldLines.length; i += 1) {
      const wanted = oldLines[i];
      if (wanted === undefined) {
        continue;
      }
      if (!PatchApplier.lineMatches(lines[start + i], wanted, level)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 单行比较（按级别放宽）。
   *
   * @param actual 文件中的实际行。
   * @param wanted hunk 中的期望行。
   * @param level 比较级别。
   * @returns 该级别下相等时为 true。
   */
  private static lineMatches(
    actual: string | undefined,
    wanted: string,
    level: MatchLevel,
  ): boolean {
    if (actual === undefined) {
      return false;
    }
    if (actual === wanted) {
      return true;
    }
    if (level === 0) {
      return false;
    }
    const left = actual.replace(/\s+$/, '');
    const right = wanted.replace(/\s+$/, '');
    if (left === right) {
      return true;
    }
    if (level === 1) {
      return false;
    }
    return PatchApplier.withoutLineNumber(left) === PatchApplier.withoutLineNumber(right);
  }

  /**
   * 剥掉行首的行号前缀（`  41→` / `41:` / `41|`）。
   *
   * @param line 已做行尾归一的行。
   * @returns 无前缀时的原行。
   */
  private static withoutLineNumber(line: string): string {
    return line.replace(LINE_NUMBER_PREFIX, '').replace(/[ \t]+$/, '');
  }

  /**
   * 取 hunk 的旧侧行（上下文 + 删除），剥掉前缀字符。
   *
   * @param hunk 待处理 hunk。
   * @returns 旧侧行数组。
   */
  private static oldSideOf(hunk: Hunk): readonly string[] {
    return hunk.lines.filter(PatchApplier.isContextual).map(PatchApplier.contentOf);
  }

  /**
   * 该行是否属于旧侧（` ` 或 `-`）。
   *
   * @param line hunk 体行。
   * @returns 属旧侧时为 true。
   */
  private static isContextual(line: string): boolean {
    const op = line.charAt(0);
    return op === ' ' || op === '-';
  }

  /**
   * 取 hunk 体行的内容（剥掉首字符前缀）。
   *
   * @param line hunk 体行。
   * @returns 行内容。
   */
  private static contentOf(line: string): string {
    return line.slice(1);
  }
}
