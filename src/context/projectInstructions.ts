import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * ProjectInstructions — 宿主类：收拢本模块原顶层内部函数（C7 顶层函数收敛），提供统一命名空间。
 */
class ProjectInstructions {
  /**
   * 默认读取器：失败抛错，由调用方 fail-closed 跳过。
   * @param {string} path - path
   * @returns {unknown} - result
   */
  public static defaultReader: InstructionReader = async (path: string) =>
    await readFile(path, 'utf8');

  /**
   * 路径是否位于 `root` 之内（防 `@import` 穿越出工作区）。
   * @param {string} root - root
   * @param {string} target - target
   * @returns {boolean} - result
   */
  public static isInside(root: string, target: string): boolean {
    const rel = relative(resolve(root), resolve(target));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  /**
   * 取 `home` 目录：优先显式参数，其次环境变量，最后 os.homedir()。
   * @param {string | undefined} explicit - explicit
   * @returns {string | undefined} - result
   */
  public static homeOf(explicit: string | undefined): string | undefined {
    if (explicit !== undefined && explicit !== '') {
      return explicit;
    }
    const fromEnv = process.env['HOME'] ?? process.env['USERPROFILE'];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
  }

  /**
   * 展开正文里的 `@import` / `@path` 引用（Claude Code 约定）。 相对路径按被引用文件所在目录解析；越界、超深、读取失败一律跳过（fail-closed）。
   * @param {string} body - body
   * @param {string} sourcePath - sourcePath
   * @param {string} workspaceRoot - workspaceRoot
   * @param {InstructionReader} read - read
   * @param {number} depth - depth
   * @returns {Promise<string>} - result
   */
  public static async expandImports(
    body: string,
    sourcePath: string,
    workspaceRoot: string,
    read: InstructionReader,
    depth: number,
  ): Promise<string> {
    if (depth >= MAX_IMPORT_DEPTH) {
      return body;
    }
    const lines = body.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      const match = /^\s*@(?:import\s+)?(.+?)\s*$/.exec(line);
      if (match === null) {
        out.push(line);
        continue;
      }
      const raw = match[1] ?? '';
      if (raw === '' || raw.startsWith('@')) {
        out.push(line);
        continue;
      }
      const target = resolve(dirname(sourcePath), raw);
      if (!ProjectInstructions.isInside(workspaceRoot, target)) {
        out.push(`<!-- 已忽略越界引用: ${raw} -->`);
        continue;
      }
      try {
        const imported = await read(target);
        out.push(
          await ProjectInstructions.expandImports(imported, target, workspaceRoot, read, depth + 1),
        );
      } catch {
        out.push(`<!-- 已忽略不可读引用: ${raw} -->`);
      }
    }
    return out.join('\n');
  }

  /**
   * 读取单个候选文件；不存在或不可读返回 null（fail-closed）。
   * @param {string} path - path
   * @param {InstructionReader} read - read
   * @returns {Promise<string | null>} - result
   */
  public static async tryRead(path: string, read: InstructionReader): Promise<string | null> {
    try {
      return await read(path);
    } catch {
      return null;
    }
  }

  /**
   * 收集**用户级**候选路径：home 下每个兼容目录 × 每个指令文件名。
   * @param {string | undefined} home - home
   * @returns {string[]} - result
   */
  public static userLevelCandidates(home: string | undefined): string[] {
    if (home === undefined) return [];
    const out: string[] = [];
    for (const dir of USER_LEVEL_DIRS) {
      for (const name of INSTRUCTION_FILE_NAMES) out.push(join(home, dir, name));
    }
    return out;
  }

  /**
   * 判断项目级是否存在 `AGENTS.override.md`（存在则根 `AGENTS.md` 被整体取代）。
   * @param {string} workspaceRoot - workspaceRoot
   * @param {InstructionReader} read - read
   * @returns {Promise<boolean>} - result
   */
  public static async hasAgentsOverride(
    workspaceRoot: string,
    read: InstructionReader,
  ): Promise<boolean> {
    return (
      (await ProjectInstructions.tryRead(join(workspaceRoot, AGENTS_OVERRIDE_NAME), read)) !== null
    );
  }

  /**
   * 收集**项目级**候选路径。
   * @param {string} workspaceRoot - workspaceRoot
   * @param {boolean} overrideExists - overrideExists
   * @returns {string[]} - result
   */
  public static projectLevelCandidates(workspaceRoot: string, overrideExists: boolean): string[] {
    const out: string[] = [];
    if (overrideExists) out.push(join(workspaceRoot, AGENTS_OVERRIDE_NAME));
    for (const name of INSTRUCTION_FILE_NAMES) {
      if (overrideExists && name === 'AGENTS.md') continue;
      out.push(join(workspaceRoot, name));
    }
    return out;
  }

  /**
   * 收集**子目录级**候选路径：`workspaceRoot → cwd` 的每一层（越靠近 cwd 越优先）。
   * @param {string} workspaceRoot - workspaceRoot
   * @param {string} cwd - cwd
   * @returns {string[]} - result
   */
  public static subdirLevelCandidates(workspaceRoot: string, cwd: string): string[] {
    if (!ProjectInstructions.isInside(workspaceRoot, cwd)) return [];
    const rel = relative(workspaceRoot, cwd);
    const parts = rel === '' ? [] : rel.split(sep);
    const out: string[] = [];
    let current = workspaceRoot;
    for (const part of parts) {
      current = join(current, part);
      for (const name of INSTRUCTION_FILE_NAMES) out.push(join(current, name));
    }
    return out;
  }

  /**
   * 按序读取候选文件，展开 `@import` 并套用总字节上限（超限即停并标记截断）。
   * @param {readonly string[]} candidates - candidates
   * @param {MergeContext} ctx - ctx
   * @returns {Promise<MergeOutcome>} - result
   */
  public static async mergeCandidates(
    candidates: readonly string[],
    ctx: MergeContext,
  ): Promise<MergeOutcome> {
    const sections: string[] = [];
    const sources: string[] = [];
    let used = 0;
    let truncated = false;

    for (const path of candidates) {
      const body = await ProjectInstructions.tryRead(path, ctx.read);
      if (body === null || body.trim() === '') {
        continue;
      }
      const expanded = await ProjectInstructions.expandImports(
        body,
        path,
        ctx.workspaceRoot,
        ctx.read,
        0,
      );
      const chunk = `<!-- 常驻指令: ${path} -->\n${expanded.trim()}`;
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (used + bytes > ctx.maxBytes) {
        truncated = true;
        break;
      }
      sections.push(chunk);
      sources.push(path);
      used += bytes;
    }
    return { sections, sources, usedBytes: used, truncated };
  }

  /**
   * 追加 `llms.txt` 独立段落（文档可发现性约定，**不参与层级覆盖**）。 容量不足时不写入，仅标记截断——保证指令正文优先于文档索引。
   * @param {MergeOutcome} outcome - outcome
   * @param {MergeContext} ctx - ctx
   * @returns {Promise<MergeOutcome>} - result
   */
  public static async appendLlmsTxt(
    outcome: MergeOutcome,
    ctx: MergeContext,
  ): Promise<MergeOutcome> {
    const path = join(ctx.workspaceRoot, 'llms.txt');
    const body = await ProjectInstructions.tryRead(path, ctx.read);
    if (body === null || body.trim() === '') {
      return outcome;
    }
    const chunk = `<!-- 文档索引: ${path} -->\n${body.trim()}`;
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (outcome.usedBytes + bytes > ctx.maxBytes) {
      return { ...outcome, truncated: true };
    }
    return {
      sections: [...outcome.sections, chunk],
      sources: [...outcome.sources, path],
      usedBytes: outcome.usedBytes + bytes,
      truncated: outcome.truncated,
    };
  }
}

/**
 * 仓库常驻指令文件的默认总字节上限（32 KiB）。
 * 对齐 Codex CLI 对 AGENTS.md 的容量约定：超出即截断，避免单个巨型指令文件挤爆上下文。
 */
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

/** `@import` 递归展开深度上限（防御循环引用，fail-closed）。 */
const MAX_IMPORT_DEPTH = 5;

/** 单层目录下识别的指令文件名（优先级从低到高）。 */
const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'] as const;

/** 出现此文件时，同名 AGENTS.md 被整体取代（Codex 语义：override 而非合并）。 */
const AGENTS_OVERRIDE_NAME = 'AGENTS.override.md';

/** 用户级目录（相对 home）：项目自有目录在前，兼容 Claude Code 目录在后。 */
const USER_LEVEL_DIRS = ['.omniharness', '.claude'] as const;

/** 文件读取器（可注入，测试无需 mock 全局 fs）。 */
export type InstructionReader = (path: string) => Promise<string>;

/** 常驻指令加载选项。 */
export interface ProjectInstructionsOptions {
  /** 工作区根目录（项目级指令与子目录级指令的起点）。 */
  readonly workspaceRoot: string;
  /** 当前工作目录（决定子目录级指令加载深度）；默认 `process.cwd()`。 */
  readonly cwd?: string;
  /** 用户主目录（用户级指令）；默认 `os.homedir()`。 */
  readonly home?: string;
  /** 总字节上限；默认 {@link DEFAULT_INSTRUCTIONS_MAX_BYTES}。 */
  readonly maxBytes?: number;
  /** 文件读取器；默认 `node:fs/promises` 的 `readFile`。 */
  readonly read?: InstructionReader;
  /** 是否加载 `llms.txt`（文档可发现性约定）；默认 true。 */
  readonly includeLlmsTxt?: boolean;
}

/** 常驻指令加载结果。 */
export interface ProjectInstructionsResult {
  /** 拼装后的指令正文（已按层级排序、已套用容量上限）。 */
  readonly content: string;
  /** 实际纳入的文件（相对或绝对路径，按纳入顺序）。 */
  readonly sources: readonly string[];
  /** 是否因超出上限被截断。 */
  readonly truncated: boolean;
}

/** 缓存条目。 */
interface CacheEntry {
  readonly result: ProjectInstructionsResult | null;
  readonly expiresAt: number;
}

/** 进程级缓存（对齐 repoMapContext 的 TTL 模式，避免每步重复磁盘 IO）。 */
const cache = new Map<string, CacheEntry>();

/** 缓存默认有效期（毫秒）。 */
export const DEFAULT_INSTRUCTIONS_TTL_MS = 30_000;

/** 清空常驻指令缓存（测试或工作区切换时使用）。 */
export function clearProjectInstructionsCache(): void {
  cache.clear();
}

/**
 * 带进程级 TTL 缓存的加载入口。
 * 键由 workspaceRoot / cwd / home / includeLlmsTxt 组成；过期后重新读盘。
 * 无可用指令时返回 `null`（与 {@link loadProjectInstructions} 语义一致）。
 */
export async function loadProjectInstructionsCached(
  options: ProjectInstructionsOptions,
  ttlMs: number = DEFAULT_INSTRUCTIONS_TTL_MS,
): Promise<ProjectInstructionsResult | null> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = ProjectInstructions.homeOf(options.home) ?? '';
  const includeLlmsTxt = options.includeLlmsTxt !== false;
  const key = `${workspaceRoot}|${cwd}|${home}|${includeLlmsTxt}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && hit.expiresAt > now) {
    return hit.result;
  }
  const result = await loadProjectInstructions(options);
  cache.set(key, { result, expiresAt: now + ttlMs });
  return result;
}

/**
 * 加载仓库常驻指令（AGENTS.md / CLAUDE.md / llms.txt），按业界约定分层合并。
 *
 * 层级（优先级从低到高）：
 * 1. 用户级：`~/.omniharness/`、`~/.claude/` 下的同名文件；
 * 2. 项目级：工作区根目录下的 `AGENTS.md`（存在 `AGENTS.override.md` 时整体取代）、`CLAUDE.md`、`CLAUDE.local.md`；
 * 3. 子目录级：从工作区根到 `cwd` 的每一级同名文件（越靠近 cwd 越优先）。
 *
 * `llms.txt` 作为独立段落附在末尾（文档可发现性约定），不参与层级覆盖。
 * 任何单文件读取失败都静默跳过，绝不因指令文件问题阻断主流程。
 *
 * @returns 无可用指令时返回 `null`（调用方应跳过注入，而非注入空串）。
 */
/** 候选文件合并上下文（避免在深层循环里重复传递散参数）。 */
interface MergeContext {
  /** 工作区根目录（`@import` 越界判定的边界）。 */
  readonly workspaceRoot: string;
  /** 文件读取器。 */
  readonly read: InstructionReader;
  /** 总字节上限。 */
  readonly maxBytes: number;
}

/** 合并中间结果（字节数随合并递增，供 `llms.txt` 段落复用同一预算）。 */
interface MergeOutcome {
  /** 已纳入的正文片段（含来源注释头）。 */
  readonly sections: string[];
  /** 已纳入的文件路径（按纳入顺序）。 */
  readonly sources: readonly string[];
  /** 已用字节数。 */
  readonly usedBytes: number;
  /** 是否因超出上限被截断。 */
  readonly truncated: boolean;
}

/**
 * 加载仓库常驻指令（AGENTS.md / CLAUDE.md / llms.txt），按业界约定分层合并。
 *
 * 层级（优先级从低到高）：
 * 1. 用户级：`~/.omniharness/`、`~/.claude/` 下的同名文件；
 * 2. 项目级：工作区根目录下的 `AGENTS.md`（存在 `AGENTS.override.md` 时整体取代）、`CLAUDE.md`、`CLAUDE.local.md`；
 * 3. 子目录级：从工作区根到 `cwd` 的每一级同名文件（越靠近 cwd 越优先）。
 *
 * `llms.txt` 作为独立段落附在末尾（文档可发现性约定），不参与层级覆盖。
 * 任何单文件读取失败都静默跳过，绝不因指令文件问题阻断主流程。
 *
 * @param options 加载选项（工作区根、cwd、home、容量上限、读取器）
 * @returns 无可用指令时返回 `null`（调用方应跳过注入，而非注入空串）
 */
export async function loadProjectInstructions(
  options: ProjectInstructionsOptions,
): Promise<ProjectInstructionsResult | null> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = ProjectInstructions.homeOf(options.home);
  const ctx: MergeContext = {
    workspaceRoot,
    read: options.read ?? ProjectInstructions.defaultReader,
    maxBytes: options.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES,
  };

  const overrideExists = await ProjectInstructions.hasAgentsOverride(workspaceRoot, ctx.read);
  const candidates = [
    ...ProjectInstructions.userLevelCandidates(home),
    ...ProjectInstructions.projectLevelCandidates(workspaceRoot, overrideExists),
    ...ProjectInstructions.subdirLevelCandidates(workspaceRoot, cwd),
  ];

  let outcome = await ProjectInstructions.mergeCandidates(candidates, ctx);
  if (options.includeLlmsTxt !== false) {
    outcome = await ProjectInstructions.appendLlmsTxt(outcome, ctx);
  }
  if (outcome.sections.length === 0) {
    return null;
  }
  return {
    content: outcome.sections.join('\n\n'),
    sources: outcome.sources,
    truncated: outcome.truncated,
  };
}
