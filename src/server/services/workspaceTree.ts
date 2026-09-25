import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SafeFs } from './safeFs.js';

/** 工作区树/文件读取依赖：工作区根以 getter 注入，支持运行时切换工作区后仍取最新根。 */
export interface WorkspaceTreeDeps {
  /** 当前生效工作区根（每次调用实时求值）。 */
  readonly workspaceRoot: () => string;
}

/**
 * 工作区文件 RPC 服务：树形列举（UI 左栏）与文件内容读取（DiffBlock / 代码视图）。
 *
 * 与 `FsExplorer` 的分工：本类**只服务工作区内部**，路径一律 resolve 后做前缀越界校验
 * （`list`）+ 复用 `safeReadFile` 的越界校验（`readFile`），与 HTTP /files 路由共用同一套
 * 安全逻辑；跨工作区的绝对路径对话框见 `FsExplorer`。
 */
export class WorkspaceTree {
  /** 当前工作区根（getter 注入，支持运行时切换项目）。 */
  private readonly workspaceRoot: () => string;

  /**
   * @param deps 工作区根访问器
   */
  public constructor(deps: WorkspaceTreeDeps) {
    this.workspaceRoot = deps.workspaceRoot;
  }

  /**
   * 列出工作区文件树（供 UI 左栏；防目录穿越）。
   * @param params `{ path?: string; depth?: number }`，path 缺省为 `.`，depth 缺省 2
   * @returns `{ root: string; tree: unknown[] }`
   */
  public list(params: Record<string, unknown>): unknown {
    const base = resolve(this.workspaceRoot());
    const requested = typeof params['path'] === 'string' ? params['path'] : '.';
    const maxDepth = typeof params['depth'] === 'number' ? params['depth'] : 2;
    const root = resolve(base, requested);
    if (!root.startsWith(base)) {
      throw new Error('路径越界工作区');
    }
    return { root, tree: this.scan(root, maxDepth, 0) };
  }

  /**
   * 读取工作区内文件内容（供 UI DiffBlock/代码视图；防目录穿越 + 二进制/超长截断）。
   * @param params `{ path?: string; maxBytes?: number }`，maxBytes 缺省 200000
   * @returns `{ path, size, isBinary, truncated, content }`
   */
  public readFile(params: Record<string, unknown>): unknown {
    // #OBS-11：复用 safeReadFile 做工作区越界校验，与 HTTP /files 路由共一套安全逻辑。
    const rel = typeof params['path'] === 'string' ? params['path'] : '';
    const r = SafeFs.safeReadFile(this.workspaceRoot(), rel);
    if (!r.ok) {
      throw new Error(r.error);
    }
    const buf = r.buffer;
    const isBinary = buf.includes(0);
    const max = typeof params['maxBytes'] === 'number' ? params['maxBytes'] : 200000;
    const content = isBinary ? '' : buf.toString('utf8').slice(0, max);
    return { path: rel, size: buf.length, isBinary, truncated: buf.length > max, content };
  }

  /**
   * 递归扫描目录（跳过隐藏项与 node_modules，限定深度）。
   * @param dir 绝对目录
   * @param maxDepth 最大深度
   * @param current 当前深度
   * @returns 树节点数组（`{ name, path, type, children? }`）
   */
  private scan(dir: string, maxDepth: number, current: number): unknown[] {
    if (current >= maxDepth || !existsSync(dir)) {
      return [];
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const base = resolve(this.workspaceRoot());
    const out: unknown[] = [];
    for (const name of names.sort()) {
      if (name.startsWith('.') || name === 'node_modules') {
        continue;
      }
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      const rel = relative(base, full) || '.';
      const entry: Record<string, unknown> = { name, path: rel, type: isDir ? 'dir' : 'file' };
      if (isDir) {
        entry['children'] = this.scan(full, maxDepth, current + 1);
      }
      out.push(entry);
    }
    return out;
  }
}
