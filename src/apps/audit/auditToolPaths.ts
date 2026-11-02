import { AuditValues } from './auditValues.ts';
import type { AuditFileChange } from './auditTypes.ts';

/**
 * 从工具调用参数 / patch 文本里提取**被触及的文件**与增删行数。
 *
 * 只认**结构化证据**，不做猜测：
 * - 参数里的路径字段（`path` / `file_path` / `filePath` / `files[]` …）；
 * - `apply_patch` 系列补丁头（`*** Update File:` / `*** Add File:` / `*** Delete File:`）；
 * - unified diff 的 `+++ b/path` 与 `+` / `-` 行。
 *
 * 刻意**不**解析 shell 命令里的重定向（`> x`、`tee`）——那需要真正的 shell 语法分析，
 * 猜错会把"没改的文件"写进报告，比不写更糟。看板把这条口径登记为诚实边界。
 */
export class AuditToolPaths {
  /** 路径类参数名（不同 harness 的命名）。 */
  private static readonly PATH_KEYS = [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'target_file',
    'absolute_path',
  ];

  /** 补丁文本类参数名。 */
  private static readonly PATCH_KEYS = ['patch', 'input', 'diff', 'patch_text'];

  /** 单个工具调用最多记录的文件数（防异常输入把报告撑爆）。 */
  private static readonly MAX_FILES = 100;

  /**
   * 按**工具语义**提取文件：只有写类工具才计入文件表。
   *
   * 为什么不能对所有工具都跑 {@link AuditToolPaths.fromArgs}：读类工具同样带 `path` 参数
   * （`read_file` / `list_dir` / `glob`），把它们的参数当"改动文件"会让报告把只读操作写成
   * 变更——这在出证场景是**伪造证据**级别的错误。未知工具一律不计（宁可少记，不可错记）。
   * @param tool 工具名。
   * @param args 参数对象。
   * @returns 去重后的路径列表。
   */
  public static fromToolCall(tool: string, args: Record<string, unknown> | null): string[] {
    return AuditToolPaths.isWriteTool(tool) ? AuditToolPaths.fromArgs(args) : [];
  }

  /**
   * 判断工具是否可能写文件（按名字；读类优先排除）。
   *
   * 公开是因为 ACP 的 `locations` 也带读文件：只有写类工具/写类 `kind` 才把 locations
   * 计入文件表（否则一次 `read_file` 会被写成"改了文件"）。
   * @param tool 工具名（或 ACP 的 `kind`）。
   * @returns 写类为 true。
   */
  public static isWriteTool(tool: string): boolean {
    const lower = tool.toLowerCase();
    if (/(read|list|glob|grep|search|view|cat|stat|find|head|tail)/.test(lower)) {
      return false;
    }
    return /(write|edit|patch|create|delete|move|rename|replace|append|save|apply|notebook)/.test(
      lower,
    );
  }

  /**
   * 从工具调用参数对象提取文件路径。
   * @param args 参数对象（可为 null）。
   * @returns 去重后的路径列表（规范化、最多 100 条）。
   */
  public static fromArgs(args: Record<string, unknown> | null): string[] {
    if (args === null) {
      return [];
    }
    const found: string[] = [];
    for (const key of AuditToolPaths.PATH_KEYS) {
      AuditToolPaths.collect(args[key], found);
    }
    for (const key of AuditToolPaths.PATCH_KEYS) {
      const text = args[key];
      if (typeof text === 'string') {
        found.push(...AuditToolPaths.fromPatch(text));
      }
    }
    AuditToolPaths.collect(args['files'], found);
    return AuditToolPaths.unique(found);
  }

  /**
   * 从 apply_patch 文本提取文件路径。
   * @param text 补丁文本。
   * @returns 去重后的路径列表。
   */
  public static fromPatch(text: string): string[] {
    const found: string[] = [];
    const re = /^\*\*\* (?:Update|Add|Delete|Move to) File: (.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const path = match[1];
      if (path !== undefined) {
        found.push(path.trim());
      }
    }
    return AuditToolPaths.unique(found);
  }

  /**
   * 解析 unified diff 的文件与增删行数。
   * @param diff diff 文本。
   * @returns 每个文件的统计（按首次出现顺序）。
   */
  public static diffStats(diff: string): AuditFileChange[] {
    const lines = diff.split(/\r?\n/);
    const stats = new Map<string, { added: number; removed: number }>();
    let current: string | null = null;
    let inHunk = false;
    for (const line of lines) {
      const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (header !== null && header[2] !== undefined) {
        current = AuditToolPaths.normalize(header[2]);
        inHunk = false;
        AuditToolPaths.ensure(stats, current);
        continue;
      }
      if (line.startsWith('+++ ')) {
        const path = AuditToolPaths.normalize(line.slice(4));
        if (path !== '/dev/null') {
          current = path;
          AuditToolPaths.ensure(stats, current);
        }
        inHunk = false;
        continue;
      }
      if (line.startsWith('--- ')) {
        inHunk = false;
        continue;
      }
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk || current === null) {
        continue;
      }
      const entry = stats.get(current);
      if (entry === undefined) {
        continue;
      }
      if (line.startsWith('+')) {
        entry.added += 1;
      } else if (line.startsWith('-')) {
        entry.removed += 1;
      }
    }
    return [...stats.entries()].map(([path, value]) => ({
      path,
      added: value.added,
      removed: value.removed,
      touches: 1,
    }));
  }

  /**
   * 规范化路径：去空白、统一正斜杠、去掉 `./` 与 diff 的 `a/` `b/` 前缀。
   * @param raw 原始路径。
   * @returns 规范化路径；空串表示无效输入。
   */
  public static normalize(raw: string): string {
    let path = raw.trim().replace(/\\/g, '/');
    if (path.startsWith('a/') || path.startsWith('b/')) {
      path = path.slice(2);
    }
    while (path.startsWith('./')) {
      path = path.slice(2);
    }
    return path;
  }

  /**
   * 去重并保序、规范化、限量。
   * @param paths 原始路径列表。
   * @returns 去重后的路径。
   */
  private static unique(paths: readonly string[]): string[] {
    const seen: string[] = [];
    for (const raw of paths) {
      const path = AuditToolPaths.normalize(raw);
      if (path === '' || path === '/dev/null' || seen.indexOf(path) >= 0) {
        continue;
      }
      seen.push(path);
      if (seen.length >= AuditToolPaths.MAX_FILES) {
        break;
      }
    }
    return seen;
  }

  /**
   * 收集一个字段值里的路径（字符串或字符串数组）。
   * @param value 字段值。
   * @param out 收集目标。
   * @returns 收集目标（便于链式调用）。
   */
  private static collect(value: unknown, out: string[]): string[] {
    if (typeof value === 'string') {
      out.push(value);
      return out;
    }
    for (const item of AuditValues.array(value)) {
      if (typeof item === 'string') {
        out.push(item);
      }
    }
    return out;
  }

  /**
   * 确保统计表里有该文件。
   * @param stats 统计表。
   * @param path 规范化路径。
   * @returns 无返回值。
   */
  private static ensure(
    stats: Map<string, { added: number; removed: number }>,
    path: string,
  ): void {
    if (path !== '' && !stats.has(path)) {
      stats.set(path, { added: 0, removed: 0 });
    }
  }
}
