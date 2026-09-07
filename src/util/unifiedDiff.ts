/**
 * 行级 unified diff（零依赖，对标 codex diff 渲染）。
 *
 * 用 LCS 动态规划求最小编辑脚本，超大规模退化为「整体替换」以避免 O(n·m) 拖垮回合
 * （与 codex 的 `DIFF_TIMEOUT` 同思路，只是把超时换成确定性规模阈值）。
 */

/** 行级差异操作。 */
export type DiffOp =
  | { readonly kind: 'equal'; readonly text: string }
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'delete'; readonly text: string };

/** unified diff 的一个 hunk（行号 1-based）。 */
export interface DiffHunk {
  readonly beforeStart: number;
  readonly beforeCount: number;
  readonly afterStart: number;
  readonly afterCount: number;
  readonly ops: readonly DiffOp[];
}

/** LCS 表单元格上限：超出则退化，避免大文件平方级开销。 */
const MAX_LCS_CELLS = 2_000_000;

/** 默认上下文行数（unified diff 惯例）。 */
export const DEFAULT_CONTEXT_LINES = 3;

/** 计算行级差异操作序列。 */
export function diffLines(before: readonly string[], after: readonly string[]): readonly DiffOp[] {
  const table = lcsTable(before, after);
  if (table === undefined) {
    return [
      ...before.map((text): DiffOp => ({ kind: 'delete', text })),
      ...after.map((text): DiffOp => ({ kind: 'insert', text })),
    ];
  }
  return opsFromTable(before, after, table);
}

/** 把操作序列切分为带上下文的 hunk。 */
export function hunksOf(
  ops: readonly DiffOp[],
  context = DEFAULT_CONTEXT_LINES,
): readonly DiffHunk[] {
  const ranges: { start: number; end: number }[] = [];
  ops.forEach((op, index) => {
    if (op.kind === 'equal') {
      return;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end) {
      last.end = end;
      return;
    }
    ranges.push({ start, end });
  });
  return ranges.map((range) => hunkOf(ops, range.start, range.end));
}

/** 渲染单文件 unified diff（无差异时返回空串）。 */
export function renderUnifiedDiff(
  path: string,
  before: string,
  after: string,
  context = DEFAULT_CONTEXT_LINES,
): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  const hunks = hunksOf(ops, context);
  if (hunks.length === 0) {
    return '';
  }
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    lines.push(
      `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`,
    );
    for (const op of hunk.ops) {
      lines.push(`${prefixOf(op.kind)}${op.text}`);
    }
  }
  return lines.join('\n');
}

/** 拆分为行（空文本视为零行，避免产出幽灵空行）。 */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** 操作前缀（unified diff 惯例）。 */
function prefixOf(kind: DiffOp['kind']): string {
  if (kind === 'insert') {
    return '+';
  }
  return kind === 'delete' ? '-' : ' ';
}

/** LCS 后缀表；规模超限时返回 undefined 交由调用方退化。 */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array | undefined {
  const width = b.length + 1;
  if ((a.length + 1) * width > MAX_LCS_CELLS) {
    return undefined;
  }
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0);
    }
  }
  return table;
}

/** 沿 LCS 表回溯出操作序列。 */
function opsFromTable(a: readonly string[], b: readonly string[], table: Uint32Array): DiffOp[] {
  const ops: DiffOp[] = [];
  const width = b.length + 1;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', text: a[i]! });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + (j + 1)] ?? 0)) {
      ops.push({ kind: 'delete', text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'insert', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: 'delete', text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: 'insert', text: b[j]! });
    j += 1;
  }
  return ops;
}

/** 由操作区间构造 hunk（统计两侧行号与行数）。 */
function hunkOf(ops: readonly DiffOp[], start: number, end: number): DiffHunk {
  const slice = ops.slice(start, end);
  let beforeStart = 0;
  let afterStart = 0;
  for (let k = 0; k < start; k += 1) {
    if (ops[k]!.kind !== 'insert') {
      beforeStart += 1;
    }
    if (ops[k]!.kind !== 'delete') {
      afterStart += 1;
    }
  }
  let beforeCount = 0;
  let afterCount = 0;
  for (const op of slice) {
    if (op.kind !== 'insert') {
      beforeCount += 1;
    }
    if (op.kind !== 'delete') {
      afterCount += 1;
    }
  }
  return {
    beforeStart: beforeStart + 1,
    beforeCount,
    afterStart: afterStart + 1,
    afterCount,
    ops: slice,
  };
}
