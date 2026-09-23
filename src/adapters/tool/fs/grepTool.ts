import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { GlobMatcher } from '../../../util/globMatcher.js';
import { WorkspaceFileWalker } from '../../../util/workspaceFileWalker.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';

/** 输出模式。 */
type OutputMode = 'content' | 'files_with_matches' | 'count';

/** 搜索范围解析结果。 */
type ScopeResult =
  | {
      readonly ok: true;
      readonly root: string;
      readonly subdir?: string;
      readonly singleFile?: string;
    }
  | { readonly ok: false; readonly error: string };

/** 渲染选项。 */
interface RenderOptions {
  /** 命中上限。 */
  readonly maxResults: number;
  /** 每个命中额外返回的上下文行数。 */
  readonly context: number;
  /** 输出模式。 */
  readonly mode: OutputMode;
}

/** grep 汇总结果。 */
interface GrepOutcome {
  /** 各文件的渲染块。 */
  readonly blocks: readonly string[];
  /** 命中处数。 */
  readonly hits: number;
  /** 实际扫描文件数。 */
  readonly scanned: number;
  /** 被跳过的文件数。 */
  readonly skipped: number;
  /** 生效的命中上限。 */
  readonly limit: number;
}

/**
 * 内置 `grep` 工具（零依赖，纯 TS）：在工作区里按正则/字面量搜索文件内容。
 *
 * 为什么必须有：原工具集**没有 grep/glob**，模型要查代码只能手写 `shell` 里的 grep，
 * 既不可移植（Windows 无 grep）、也不受工作区边界约束，还得自己处理编码与忽略目录。
 * 本工具把「查问题」这条腿补齐（2026-09-19 能力盘点：查错能力「半具备」的主因之一）。
 *
 * 行为要点：
 * - 复用 {@link WorkspaceFileWalker}（默认忽略 `.git`/`node_modules`/构建产物/缓存，跳过符号链接）；
 * - **跳过二进制与超大文件**（NUL 字节快照判据；>2 MiB 跳过），避免把日志/图片煮成乱码上下文；
 * - 三种输出模式（`content` / `files_with_matches` / `count`）与上下文行，对齐 ripgrep 直觉；
 * - **结果截断必须显式回报**，绝不静默少给（静默截断会让模型误判「就这些」）。
 */
export class GrepTool {
  /** 默认命中上限。 */
  public static readonly DEFAULT_MAX_RESULTS = 100;

  /** 命中上限的硬上界。 */
  public static readonly MAX_RESULTS_LIMIT = 1000;

  /** 单文件读取上限（字节）。 */
  public static readonly MAX_FILE_BYTES = 2 * 1024 * 1024;

  /** 上下文行数上限。 */
  public static readonly MAX_CONTEXT_LINES = 10;

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.grep,
    description:
      '在工作区内按正则搜索文件内容（零依赖、自动忽略 .git/node_modules/构建产物）。' +
      '支持 glob 过滤、大小写忽略、字面量模式、上下文行与三种输出模式。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（literal=true 时按纯文本匹配）' },
        path: {
          type: 'string',
          description: '搜索范围：文件或子目录（相对工作区；缺省为整个工作区）',
        },
        glob: { type: 'string', description: '文件名过滤通配符，如 `*.ts` 或 `src/**/*.ts`' },
        output_mode: {
          type: 'string',
          description: 'content=带行号正文（默认）| files_with_matches=仅文件 | count=每文件计数',
        },
        case_insensitive: { type: 'boolean', description: '忽略大小写（默认 false）' },
        literal: { type: 'boolean', description: '把 pattern 当作纯文本而非正则（默认 false）' },
        context: { type: 'number', description: '每个命中额外返回的上下文行数（默认 0，上限 10）' },
        max_results: {
          type: 'number',
          description: `命中处数上限（默认 ${GrepTool.DEFAULT_MAX_RESULTS}，硬上界 ${GrepTool.MAX_RESULTS_LIMIT}）`,
        },
      },
      required: ['pattern'],
    },
  };

  /**
   * @param workspaceRoot 工作区根目录（搜索范围与路径白名单基准）。
   */
  public constructor(private readonly workspaceRoot: string) {}

  /**
   * 执行搜索。
   *
   * @param call 工具调用（实参见 {@link GrepTool.definition}）。
   * @param context 工具上下文（workspaceRoot 优先于装配时的根，支持会话级切换工作区）。
   * @returns 命中文本 + 统计脚注；正则非法 / 路径越界 / 目标不存在时返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const pattern = String(call.arguments['pattern'] ?? '');
    if (pattern === '') {
      return { callId: call.id, ok: false, error: 'pattern 不能为空' };
    }
    const regex = GrepTool.compile(pattern, {
      literal: call.arguments['literal'] === true,
      caseInsensitive: call.arguments['case_insensitive'] === true,
    });
    if (!regex.ok) {
      return { callId: call.id, ok: false, error: regex.error };
    }
    const root = context.workspaceRoot === '' ? this.workspaceRoot : context.workspaceRoot;
    const scope = await GrepTool.resolveScope(root, String(call.arguments['path'] ?? ''));
    if (!scope.ok) {
      return { callId: call.id, ok: false, error: scope.error };
    }
    const options: RenderOptions = {
      maxResults: GrepTool.clampMaxResults(call.arguments['max_results']),
      context: GrepTool.clampContext(call.arguments['context']),
      mode: GrepTool.outputMode(call.arguments['output_mode']),
    };
    const walk = await GrepTool.candidateFiles(root, scope);
    const outcome = await this.scan(
      root,
      walk.files,
      GrepTool.globFilter(call.arguments['glob']),
      regex.value,
      options,
    );
    return { callId: call.id, ok: true, output: GrepTool.render(outcome, walk.truncated) };
  }

  /**
   * 取候选文件清单（单文件 / 子目录 / 全工作区三种范围）。
   *
   * @param root 生效的工作区根。
   * @param scope 已解析的范围。
   * @returns 相对路径清单与遍历截断标记。
   */
  private static async candidateFiles(
    root: string,
    scope: { readonly subdir?: string; readonly singleFile?: string },
  ): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> {
    if (scope.singleFile !== undefined) {
      return { files: [scope.singleFile], truncated: false };
    }
    const walk = await new WorkspaceFileWalker(root).list();
    if (scope.subdir === undefined) {
      return walk;
    }
    const prefix = `${scope.subdir}/`;
    return {
      files: walk.files.filter((file) => file.startsWith(prefix)),
      truncated: walk.truncated,
    };
  }

  /**
   * 批量扫描文件。
   *
   * @param root 生效的工作区根。
   * @param files 候选文件（相对 root 的 POSIX 路径）。
   * @param filter 文件名过滤（undefined 表示不过滤）。
   * @param regex 已编译的正则。
   * @param options 预算与呈现选项。
   * @returns 各文件的命中与统计。
   */
  private async scan(
    root: string,
    files: readonly string[],
    filter: GlobMatcher | undefined,
    regex: RegExp,
    options: RenderOptions,
  ): Promise<GrepOutcome> {
    const blocks: string[] = [];
    let hits = 0;
    let scanned = 0;
    let skipped = 0;
    for (const file of files) {
      if (hits >= options.maxResults) {
        break;
      }
      if (filter !== undefined && !filter.test(file)) {
        continue;
      }
      const content = await GrepTool.readText(root, file);
      if (content === undefined) {
        skipped += 1;
        continue;
      }
      scanned += 1;
      const lines = content.split('\n');
      const matched = GrepTool.matchLines(lines, regex);
      if (matched.length === 0) {
        continue;
      }
      hits += matched.length;
      const block = GrepTool.renderFile(file, lines, matched, options);
      if (block !== '') {
        blocks.push(block);
      }
    }
    return { blocks, hits, scanned, skipped, limit: options.maxResults };
  }

  /**
   * 找出所有命中行（1-based 行号）。
   *
   * @param lines 文件行数组。
   * @param regex 已编译正则。
   * @returns 命中行号列表（按行序）。
   */
  private static matchLines(lines: readonly string[], regex: RegExp): readonly number[] {
    const matched: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i] ?? '')) {
        matched.push(i + 1);
      }
    }
    return matched;
  }

  /**
   * 渲染单文件结果块（按输出模式）。
   *
   * @param file 相对路径。
   * @param lines 文件行数组。
   * @param matched 命中行号列表（1-based，按行序）。
   * @param options 预算与呈现选项。
   * @returns 多行文本；`content` 模式下附上下文行。
   */
  private static renderFile(
    file: string,
    lines: readonly string[],
    matched: readonly number[],
    options: RenderOptions,
  ): string {
    if (options.mode === 'files_with_matches') {
      return `${file} (${matched.length} 处命中)`;
    }
    if (options.mode === 'count') {
      return `${file}: ${matched.length}`;
    }
    const printed = new Set<number>();
    const out: string[] = [];
    for (const line of matched.slice(0, options.maxResults)) {
      const from = Math.max(1, line - options.context);
      const to = Math.min(lines.length, line + options.context);
      for (let current = from; current <= to; current += 1) {
        if (printed.has(current)) {
          continue;
        }
        printed.add(current);
        const marker = current === line ? ':' : '-';
        out.push(`${file}${marker}${current}${marker}${lines[current - 1] ?? ''}`);
      }
    }
    return out.join('\n');
  }

  /**
   * 汇总渲染（块 + 统计脚注）。
   *
   * @param outcome 扫描汇总。
   * @param walkTruncated 文件遍历是否被上限截断。
   * @returns 最终工具输出。
   */
  private static render(outcome: GrepOutcome, walkTruncated: boolean): string {
    const notes = [
      `扫描 ${outcome.scanned} 个文件，命中 ${outcome.hits} 处`,
      outcome.skipped > 0 ? `跳过 ${outcome.skipped} 个（二进制/超大/不可读）` : '',
      outcome.hits >= outcome.limit ? `已达上限 ${outcome.limit}，结果可能不完整` : '',
      walkTruncated ? '文件遍历被上限截断' : '',
    ].filter((note) => note !== '');
    const body = outcome.blocks.length > 0 ? `${outcome.blocks.join('\n')}\n` : '（无命中）\n';
    return `${body}[grep: ${notes.join('；')}]`;
  }

  /**
   * 读取并解码文本文件；二进制或超大文件返回 undefined（计为跳过）。
   *
   * @param root 生效的工作区根。
   * @param file 相对 root 的 POSIX 路径。
   * @returns 文件文本；不可读 / 二进制 / 超限时为 undefined。
   */
  private static async readText(root: string, file: string): Promise<string | undefined> {
    const absolute = resolve(root, file);
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > GrepTool.MAX_FILE_BYTES) {
        return undefined;
      }
      const buffer = await readFile(absolute);
      return GrepTool.hasNulByte(buffer) ? undefined : buffer.toString('utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * 解析搜索范围（缺省为整个工作区；给文件则只搜该文件；给目录则限定其子树）。
   *
   * @param root 生效的工作区根。
   * @param raw 用户给出的 `path` 参数（可为空）。
   * @returns 成功时给出子目录 / 单文件标记；越界 / 不存在时给出错误。
   */
  private static async resolveScope(root: string, raw: string): Promise<ScopeResult> {
    const trimmed = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '.') {
      return { ok: true, root };
    }
    const guard = new WorkspaceGuard(root);
    if (!guard.isInside(trimmed)) {
      return { ok: false, error: `路径越界: "${raw}" 不在工作区内` };
    }
    try {
      const info = await stat(resolve(root, trimmed));
      return info.isFile()
        ? { ok: true, root, singleFile: trimmed }
        : { ok: true, root, subdir: trimmed };
    } catch {
      return { ok: false, error: `路径不存在: ${raw}` };
    }
  }

  /**
   * 编译正则（支持字面量与大小写忽略）。
   *
   * @param pattern 用户模式。
   * @param options 编译选项。
   * @returns 成功给正则；非法模式给可读错误（不抛）。
   */
  private static compile(
    pattern: string,
    options: { readonly literal: boolean; readonly caseInsensitive: boolean },
  ):
    { readonly ok: true; readonly value: RegExp } | { readonly ok: false; readonly error: string } {
    const source = options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    try {
      return { ok: true, value: new RegExp(source, options.caseInsensitive ? 'i' : '') };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `正则表达式非法: ${detail}` };
    }
  }

  /**
   * 构造文件名过滤器。
   *
   * @param raw `glob` 参数（未知类型）。
   * @returns 过滤器；未给出时为 undefined。
   */
  private static globFilter(raw: unknown): GlobMatcher | undefined {
    return typeof raw === 'string' && raw !== '' ? new GlobMatcher(raw) : undefined;
  }

  /**
   * 解析输出模式。
   *
   * @param raw `output_mode` 参数（未知类型）。
   * @returns 生效模式（非法值回落 content）。
   */
  private static outputMode(raw: unknown): OutputMode {
    if (raw === 'files_with_matches' || raw === 'count' || raw === 'content') {
      return raw;
    }
    return 'content';
  }

  /**
   * 钳制命中上限。
   *
   * @param raw `max_results` 参数（未知类型）。
   * @returns 生效上限。
   */
  private static clampMaxResults(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return GrepTool.DEFAULT_MAX_RESULTS;
    }
    return Math.min(Math.max(1, Math.floor(raw)), GrepTool.MAX_RESULTS_LIMIT);
  }

  /**
   * 钳制上下文行数。
   *
   * @param raw `context` 参数（未知类型）。
   * @returns 生效上下文行数（0..{@link GrepTool.MAX_CONTEXT_LINES}）。
   */
  private static clampContext(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return 0;
    }
    return Math.min(Math.max(0, Math.floor(raw)), GrepTool.MAX_CONTEXT_LINES);
  }

  /**
   * 二进制嗅探：前 8 KiB 出现 NUL 即判为非文本。
   *
   * @param buffer 文件字节。
   * @returns 含 NUL 时为 true。
   */
  private static hasNulByte(buffer: Buffer): boolean {
    const limit = Math.min(buffer.length, 8192);
    for (let i = 0; i < limit; i += 1) {
      if (buffer[i] === 0) {
        return true;
      }
    }
    return false;
  }
}
