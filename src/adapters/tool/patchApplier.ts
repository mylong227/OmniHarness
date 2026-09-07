/** Unified diff 应用结果。 */
export interface PatchApplierResult {
  readonly ok: boolean;
  readonly targetFile?: string;
  readonly newContent?: string;
  readonly error?: string;
}

/** 补丁 hunk。 */
interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  lines: string[];
}

/** Unified diff 应用器：解析并应用到文件内容（纯逻辑，失败不改动原内容）。 */
export class PatchApplier {
  /** 应用补丁。 */
  apply(original: string, patch: string): PatchApplierResult {
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

  /** 解析补丁（仅取目标文件与 hunk，供调用方先校验）。 */
  parse(
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

  /** 提取目标文件。 */
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

  /** 解析全部 hunk。 */
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

  /** 解析 hunk 头。 */
  private parseHeader(line: string): { oldStart: number; oldCount: number } | undefined {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (match === null) {
      return undefined;
    }
    return { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1) };
  }

  /** 应用单个 hunk，成功返回新偏移。 */
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
