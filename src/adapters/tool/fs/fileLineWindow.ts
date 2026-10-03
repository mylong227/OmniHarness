/**
 * 文件行窗口（无第三方依赖，纯逻辑）：`read_file` 的取行内核。
 *
 * 为什么需要它：原 `read_file` **无 offset / limit、也不给行号**，于是形成本仓「读不给行号、
 * 改却要行号」的复合故障——模型只能整文件读回，再靠猜行号写 `apply_patch`，一猜偏就失败
 * （2026-09-19 能力盘点实测：6 类常见模型 diff 有 4 类直接失败，其中「行号写偏」居首）。
 *
 * 本类提供三个能力：
 * - **定点读取**（`offset` / `limit`），大文件不必整读，省上下文；
 * - **行号渲染**（默认开启），行号即真实行号，可直接用于 diff hunk 头；
 * - **确定性回报**（起止行 / 总行数 / 是否还有更多），让模型明确知道「读到哪了」，
 *   必须显式分页而不是以为文件就这么点内容。
 *
 * 与 `edit` 工具的配合：`edit` 的模糊匹配会剥掉行号前缀（见 `StringReplaceEditor`），
 * 所以这里带行号输出**不会**污染后续替换。
 */
/** 取行选项。 */
export interface LineWindowOptions {
  /** 起始行（1 起；默认 1）。 */
  readonly offset?: number;
  /** 最多返回多少行（默认 {@link FileLineWindow.DEFAULT_LINES}）。 */
  readonly limit?: number;
  /** 是否渲染行号前缀（默认 true）。 */
  readonly numbered?: boolean;
}

/** 取行结果。 */
export interface LineWindowResult {
  /** 渲染后的文本（含行号前缀，若启用）。 */
  readonly text: string;
  /** 实际起始行（1 起）。 */
  readonly startLine: number;
  /** 实际结束行（1 起；空窗口时为 `startLine - 1`）。 */
  readonly endLine: number;
  /** 文件总行数（空文件为 0）。 */
  readonly totalLines: number;
  /** 之后是否还有未返回的行。 */
  readonly truncated: boolean;
  /** 请求的起始行是否已越过文件末尾。 */
  readonly pastEnd: boolean;
}

/** 行窗口渲染器（无状态）。 */
export class FileLineWindow {
  /** 单次默认返回行数。 */
  public static readonly DEFAULT_LINES = 2000;

  /** 单次返回行数上限（防一次性把上下文撑爆）。 */
  public static readonly MAX_LINES = 5000;

  /**
   * 单次返回的**字节**预算（UTF-8，512 KiB；2026-10-03 修，审计 T1）。
   * 行数上限挡不住「单行 20 MB 的 minified bundle」——5000 行上限对一行式文件形同虚设，
   * 读一次就是数十 MB 进上下文（外溢后经 `spill_read` 回读仍会整段进模型）。
   * 超预算即停行，并显式追加截断标记（绝不静默）。
   */
  public static readonly MAX_WINDOW_BYTES = 512 * 1024;

  /**
   * 取行窗口。
   *
   * @param content 文件内容。
   * @param options 取行选项（offset / limit / numbered）。
   * @returns 渲染文本与定位元信息（越界请求返回空窗口 + `pastEnd`，不抛错）。
   */
  public static slice(content: string, options: LineWindowOptions = {}): LineWindowResult {
    const lines = FileLineWindow.linesOf(content);
    const totalLines = lines.length;
    const offset = Math.max(1, Math.floor(options.offset ?? 1));
    const limit = FileLineWindow.clampLimit(options.limit);
    const numbered = options.numbered !== false;
    // 空文件（0 行）没有「越界」可言：`offset=1` 只是「从开头读一个空窗口」。
    // 若仍以 `offset > totalLines` 判定，`read_file` 读空文件会误报「已越过文件末尾」，
    // 与「空文件应给出明确提示」的契约冲突（fileLineWindow / readFileTool 单测实测）。
    if (offset > Math.max(totalLines, 1)) {
      return {
        text: '',
        startLine: offset,
        endLine: offset - 1,
        totalLines,
        truncated: false,
        pastEnd: true,
      };
    }
    const startIndex = offset - 1;
    const endIndex = Math.min(startIndex + limit, totalLines);
    const slice = lines.slice(startIndex, endIndex);
    // 字节预算截断（2026-10-03 修，审计 T1）：行数上限对「单行 20MB 的 minified bundle」
    // 形同虚设。逐行累计 UTF-8 字节，超 {@link MAX_WINDOW_BYTES} 即停行并显式标记；
    // 首行自身超预算时按**码点**裁剪该行（不能让单行文件绕过护栏），同样显式标记。
    const budgeted: string[] = [];
    let bytes = 0;
    let byteTruncated = false;
    for (let i = 0; i < slice.length; i += 1) {
      const line = slice[i] ?? '';
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + lineBytes > FileLineWindow.MAX_WINDOW_BYTES && budgeted.length > 0) {
        byteTruncated = true;
        break;
      }
      if (bytes + lineBytes > FileLineWindow.MAX_WINDOW_BYTES && budgeted.length === 0 && i === 0) {
        budgeted.push(FileLineWindow.clipToByteBudget(line, FileLineWindow.MAX_WINDOW_BYTES));
        byteTruncated = true;
        break;
      }
      budgeted.push(line);
      bytes += lineBytes;
    }
    const endLine = offset - 1 + budgeted.length;
    const text = numbered ? FileLineWindow.number(budgeted, offset) : budgeted.join('\n');
    const marker = byteTruncated
      ? `\n…[窗口因字节预算（${String(Math.round(FileLineWindow.MAX_WINDOW_BYTES / 1024))} KiB）截断，` +
        `已返回 ${String(budgeted.length)}/${String(slice.length)} 行；请用 offset 继续分页或用 grep 定位]`
      : '';
    return {
      text: text + marker,
      startLine: offset,
      endLine,
      totalLines,
      truncated: byteTruncated || endIndex < totalLines,
      pastEnd: false,
    };
  }

  /**
   * 按码点把单行裁剪到字节预算内（不产生孤立代理项），并附显式截断说明。
   * @param line 超预算的行。
   * @param maxBytes 字节上限。
   * @returns 裁剪后的行（尾部带 `[本行已截断]` 标记）。
   */
  private static clipToByteBudget(line: string, maxBytes: number): string {
    let bytes = 0;
    let out = '';
    for (const cp of line) {
      const width = Buffer.byteLength(cp, 'utf8');
      if (bytes + width > maxBytes) {
        return `${out}…[本行已截断]`;
      }
      bytes += width;
      out += cp;
    }
    return out;
  }

  /**
   * 拆行（空内容视为 0 行，避免 `''.split('\n')` 产出的一行空串）。
   *
   * @param content 文件内容。
   * @returns 行数组。
   */
  private static linesOf(content: string): readonly string[] {
    return content === '' ? [] : content.split('\n');
  }

  /**
   * 钳制 limit 到 `[1, MAX_LINES]`。
   *
   * @param limit 请求的行数（可为 undefined / 非整数 / 非正数）。
   * @returns 生效行数。
   */
  private static clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return FileLineWindow.DEFAULT_LINES;
    }
    const floored = Math.floor(limit);
    if (floored < 1) {
      return 1;
    }
    return Math.min(floored, FileLineWindow.MAX_LINES);
  }

  /**
   * 渲染行号前缀（宽度按窗口内最大行号右对齐，便于视觉对齐）。
   *
   * @param lines 窗口内的行。
   * @param startLine 窗口起始行号（1 起）。
   * @returns 带 `行号→内容` 前缀的文本。
   */
  private static number(lines: readonly string[], startLine: number): string {
    const width = String(startLine + lines.length - 1).length;
    return lines
      .map((line, index) => `${String(startLine + index).padStart(width)}→${line}`)
      .join('\n');
  }
}
