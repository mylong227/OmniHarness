/**
 * 工作区文件遍历器（零依赖）：`grep` / `glob` 的取文件底座。
 *
 * 设计要点（都是编码 Agent 检索时真会踩到的）：
 * - **默认忽略重目录**（`.git` / `node_modules` / `dist` / venv / 各类缓存），否则一次全量遍历
 *   会读到十几万条噪音并且慢到不可用；
 * - **跳过符号链接**（`isSymbolicLink`）——目录循环链接会让遍历永不终止；
 * - **文件数硬上限**（默认 20000）并**显式回报 `truncated`**，让调用方能告诉模型「结果被截断」，
 *   而不是悄悄少给一半结果（静默截断会把模型引向错误结论）；
 * - **确定性排序**（字典序），保证同一工作区两次遍历产出逐字相同 ⇒ 工具输出可断言、可复现。
 */
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** 遍历选项。 */
export interface WorkspaceWalkOptions {
  /** 最多返回多少文件（默认 {@link WorkspaceFileWalker.DEFAULT_MAX_FILES}）。 */
  readonly maxFiles?: number;
  /** 最大目录深度（根目录下第一层为 1，默认 32）。 */
  readonly maxDepth?: number;
  /** 额外忽略的目录名（叠加在内置清单之上）。 */
  readonly ignoredDirs?: readonly string[];
  /** 是否包含点文件 / 点目录（默认 false）。 */
  readonly includeHidden?: boolean;
}

/** 遍历结果。 */
export interface WorkspaceWalkResult {
  /** 相对工作区的 POSIX 路径（字典序）。 */
  readonly files: readonly string[];
  /** 是否因 `maxFiles` 上限被截断（调用方应把它转达给模型，不要静默丢弃）。 */
  readonly truncated: boolean;
}

/** 工作区文件遍历器（实例持有根目录与选项，可复用）。 */
export class WorkspaceFileWalker {
  /** 默认忽略的目录名（版本控制、依赖、构建产物、缓存、harness 运行时产物）。 */
  public static readonly DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'target',
    '__pycache__',
    '.venv',
    'venv',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    '.next',
    '.nuxt',
    '.cache',
    '.omniharness',
    '.omni-worktrees',
    'eval-data',
  ]);

  /** 默认文件数上限。 */
  public static readonly DEFAULT_MAX_FILES = 20000;

  /** 默认最大深度。 */
  public static readonly DEFAULT_MAX_DEPTH = 32;

  /** 工作区根目录（绝对路径）。 */
  private readonly root: string;
  /** 生效的忽略目录集合。 */
  private readonly ignored: ReadonlySet<string>;
  /** 文件数上限。 */
  private readonly maxFiles: number;
  /** 最大深度。 */
  private readonly maxDepth: number;
  /** 是否包含点文件。 */
  private readonly includeHidden: boolean;

  /**
   * @param root 工作区根目录（绝对路径）。
   * @param options 遍历选项（缺省取保守默认值）。
   */
  public constructor(root: string, options: WorkspaceWalkOptions = {}) {
    this.root = root;
    this.ignored = new Set([
      ...WorkspaceFileWalker.DEFAULT_IGNORED_DIRS,
      ...(options.ignoredDirs ?? []),
    ]);
    this.maxFiles = options.maxFiles ?? WorkspaceFileWalker.DEFAULT_MAX_FILES;
    this.maxDepth = options.maxDepth ?? WorkspaceFileWalker.DEFAULT_MAX_DEPTH;
    this.includeHidden = options.includeHidden === true;
  }

  /**
   * 遍历工作区，返回相对路径清单。
   *
   * @returns 相对 POSIX 路径（字典序）与截断标记；不可读目录静默跳过，绝不抛错。
   */
  public async list(): Promise<WorkspaceWalkResult> {
    const files: string[] = [];
    let truncated = false;
    const stack: Array<{ readonly dir: string; readonly depth: number }> = [
      { dir: this.root, depth: 0 },
    ];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      const entries = await this.readDir(current.dir);
      for (const entry of entries) {
        if (files.length >= this.maxFiles) {
          truncated = true;
          return { files: files.sort(), truncated };
        }
        const name = entry.name;
        if (entry.isDirectory()) {
          if (this.shouldDescend(name, current.depth + 1)) {
            stack.push({ dir: join(current.dir, name), depth: current.depth + 1 });
          }
          continue;
        }
        if (entry.isFile() && this.shouldInclude(name)) {
          files.push(relative(this.root, join(current.dir, name)).split(sep).join('/'));
        }
      }
    }
    return { files: files.sort(), truncated };
  }

  /**
   * 读取目录条目；不可读（权限/竞态删除）时返回空数组。
   *
   * @param dir 目录绝对路径。
   * @returns 目录条目列表（含类型信息）。
   */
  private async readDir(
    dir: string,
  ): Promise<readonly { name: string; isDirectory(): boolean; isFile(): boolean }[]> {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /**
   * 该目录名是否应下探（忽略清单 / 深度 / 点目录三者共同裁决）。
   *
   * @param name 目录名。
   * @param depth 该目录相对根的深度。
   * @returns 可下探时为 true。
   */
  private shouldDescend(name: string, depth: number): boolean {
    if (depth > this.maxDepth) {
      return false;
    }
    if (this.ignored.has(name)) {
      return false;
    }
    return this.includeHidden || !name.startsWith('.');
  }

  /**
   * 该文件名是否应计入结果。
   *
   * @param name 文件名。
   * @returns 计入时为 true。
   */
  private shouldInclude(name: string): boolean {
    return this.includeHidden || !name.startsWith('.');
  }
}
