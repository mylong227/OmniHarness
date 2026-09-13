/** Unified diff 应用结果。 */
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

/** 补丁 hunk。 */
interface Hunk {
  /** 旧文件起始行号（1 起）。 */
  readonly oldStart: number;
  /** 旧文件中被替换的行数。 */
  readonly oldCount: number;
  /** hunk 体行（前缀 ' '/'-'/'+'/'\'）。 */
  lines: string[];
}

/** Unified diff 应用器：解析并应用到文件内容（纯逻辑，失败不改动原内容）。 */
export class PatchApplier {
  /** 应用补丁。
   * @param original 原文件内容。
   * @param patch unified diff 补丁文本。
   * @returns 应用结果：成功附目标文件与新内容；任一 hunk 失败即整体失败且不改动原内容。
   */
  public apply(original: string, patch: string): PatchApplierResult {
    const parsed = this.parse(patch);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const lines = original.split('\n');
    let offset = 0;
    for (const hunk of parsed.hunks) {
      const applied = this.applyHunk(lines, hunk, offset);
      if (!applied.ok) {
        return { ok: false, error: applied.error };
      }
      offset = applied.offset;
    }
    return { ok: true, targetFile: parsed.targetFile, newContent: lines.join('\n') };
  }

  /** 解析补丁（仅取目标文件与 hunk，供调用方先校验）。
   * @param patch unified diff 补丁文本。
   * @returns 解析成功附目标文件与 hunk 列表；缺少文件头或有效 hunk 时附错误。
   */
  public parse(
    patch: string,
  ): { ok: true; targetFile: string; hunks: readonly Hunk[] } | { ok: false; error: string } {
    const targetFile = this.targetFileOf(patch);
    if (targetFile === '') {
      return { ok: false, error: 'patch 缺少 +++ 目标文件头' };
    }
    const hunks = this.parseHunks(patch);
    if (hunks === undefined) {
      return { ok: false, error: 'patch 缺少有效 @@ hunk' };
    }
    return { ok: true, targetFile, hunks };
  }

  /** 提取目标文件。
   * @param patch 补丁文本。
   * @returns `+++` 头中的目标文件路径（剥 a/ b/ 前缀）；缺失返回空串。
   */
  private targetFileOf(patch: string): string {
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++ ')) {
        return line
          .slice(4)
          .trim()
          .replace(/^[ab]\//, '');
      }
    }
    return '';
  }

  /** 解析全部 hunk。
   * @param patch 补丁文本。
   * @returns hunk 数组（按出现顺序）；无有效 hunk 或头部非法时为 undefined。
   */
  private parseHunks(patch: string): readonly Hunk[] | undefined {
    const hunks: Hunk[] = [];
    let current: Hunk | undefined;
    for (const line of patch.split('\n')) {
      if (line.startsWith('@@ ')) {
        const header = this.parseHeader(line);
        if (header === undefined) {
          return undefined;
        }
        current = { oldStart: header.oldStart, oldCount: header.oldCount, lines: [] };
        hunks.push(current);
      } else if (current !== undefined && line !== '') {
        current.lines = [...current.lines, line];
      }
    }
    return hunks.length > 0 ? hunks : undefined;
  }

  /** 解析 hunk 头。
   * @param line `@@ -oldStart[,oldCount] ...` 格式的头行。
   * @returns 旧文件起始行与行数；格式非法为 undefined。
   */
  private parseHeader(line: string): { oldStart: number; oldCount: number } | undefined {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (match === null) {
      return undefined;
    }
    return { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1) };
  }

  /** 应用单个 hunk，成功返回新偏移。
   * @param lines 当前文件行数组（原地修改）。
   * @param hunk 待应用的 hunk。
   * @param offset 前序 hunk 累计的行数偏移。
   * @returns 应用结果：成功附累计偏移；上下文不匹配时失败并附错误。
   */
  private applyHunk(
    lines: string[],
    hunk: Hunk,
    offset: number,
  ): { ok: boolean; offset: number; error?: string } {
    let oldIndex = hunk.oldStart - 1 + offset;
    const applied: string[] = [];
    for (const line of hunk.lines) {
      const op = line[0];
      const content = line.slice(1);
      if (op === ' ' || op === '-') {
        if (lines[oldIndex] !== content) {
          return { ok: false, offset, error: `第 ${oldIndex + 1} 行上下文不匹配` };
        }
        if (op === ' ') {
          applied.push(content);
        }
        oldIndex += 1;
      } else if (op === '+') {
        applied.push(content);
      }
      // '\' 无换行符标记忽略
    }
    const start = hunk.oldStart - 1 + offset;
    lines.splice(start, hunk.oldCount, ...applied);
    return { ok: true, offset: offset + (applied.length - hunk.oldCount) };
  }
}
