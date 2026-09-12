import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 搜索命中条目（文件或聊天）。 */
export interface SearchHit {
  /** 条目类型。 */
  readonly kind: 'file' | 'chat';
  /** 文件为工作区相对路径；聊天为会话 id。 */
  readonly id: string;
  /** 展示名（文件取基名，聊天取会话标签）。 */
  readonly label: string;
  /** 补充信息（文件的目录前缀 / 聊天的更新时间），UI 以次要样式显示。 */
  readonly hint: string;
}

/** 搜索依赖。 */
export interface WorkspaceSearchDeps {
  /** 当前工作区根（getter 注入，跟随项目切换）。 */
  readonly workspaceRoot: () => string;
  /** 会话清单（`SessionArchive.list` 的 sessions 字段）。 */
  readonly chats: () => readonly {
    readonly sessionId: string;
    readonly label: string;
    readonly workspace?: string;
    readonly updatedAt: string;
  }[];
}

/** 搜索上限（防御性：避免一次性把上万条路径推给 UI）。 */
const MAX_HITS = 20;

/** 遍历深度上限：够覆盖常规项目结构，又不至于在 monorepo 里卡住。 */
const MAX_DEPTH = 6;

/** 访问条目数上限（防止超大仓库把一次搜索拖成秒级）。 */
const MAX_VISITED = 6000;

/** 遍历时跳过的目录名（VCS / 依赖 / 构建产物 / 本工具自身产物）。 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
  '.omniharness',
  '.omni-worktrees',
]);

/**
 * 工作区搜索服务：一条查询同时搜「文件」与「聊天（历史会话）」。
 *
 * 对应 UI 的「+ → 文件和聊天」入口：用户在输入框里敲一个词，想找的是
 * 「那个文件」或「那次聊过的地方」，二者混排比只搜文件更贴合真实意图。
 *
 * 实现纪律：
 *  - **只读**：仅 `readdir` + `stat`，不打开文件内容、不建索引、不留缓存文件；
 *  - 有界：深度、访问条目数、命中数三重上限，任何一个触顶即停（宁可少给，不可卡住 UI）；
 *  - fail-closed：任何目录不可读（权限、竞态删除）都跳过该分支并继续，绝不整体抛错。
 */
export class WorkspaceSearchService {
  /**
   * @param deps 工作区根与会话清单两个取数器
   */
  public constructor(private readonly deps: WorkspaceSearchDeps) {}

  /**
   * 执行搜索。
   * @param query 查询词（空串返回空结果——空查询在 UI 侧应展示「最近项」而不是全量清单）
   * @param limit 每类命中上限（缺省 {@link MAX_HITS}）
   * @returns `{ files, chats }`：文件按「基名命中优先、路径短优先」排序
   */
  public search(
    query: string,
    limit: number = MAX_HITS,
  ): { files: SearchHit[]; chats: SearchHit[] } {
    const needle = query.trim().toLowerCase();
    if (needle === '') return { files: [], chats: [] };
    const capped = Math.max(1, Math.min(limit, MAX_HITS));
    return {
      files: this.searchFiles(needle, capped),
      chats: this.searchChats(needle, capped),
    };
  }

  /** 搜文件：BFS 遍历工作区，命中相对路径包含查询词的文件。 */
  private searchFiles(needle: string, limit: number): SearchHit[] {
    const root = this.deps.workspaceRoot();
    const hits: SearchHit[] = [];
    let visited = 0;
    const queue: { readonly dir: string; readonly depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && hits.length < limit * 4 && visited < MAX_VISITED) {
      const current = queue.shift();
      if (current === undefined) break;
      let entries: string[];
      try {
        entries = readdirSync(current.dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        visited += 1;
        if (visited >= MAX_VISITED) break;
        const absolute = join(current.dir, name);
        let isDir = false;
        try {
          isDir = statSync(absolute).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          if (current.depth + 1 <= MAX_DEPTH && !SKIP_DIRS.has(name)) {
            queue.push({ dir: absolute, depth: current.depth + 1 });
          }
          continue;
        }
        // 路径统一用正斜杠参与匹配与展示：Windows 的原生反斜杠会让「src/ui」这类
        // 用户输入永远匹配不到，也会让命中排序（按路径长度）产生平台差异。
        const relativePath = relative(root, absolute).split(sep).join('/');
        if (relativePath.toLowerCase().includes(needle)) {
          hits.push({
            kind: 'file',
            id: relativePath,
            label: name,
            hint: relativePath.slice(0, Math.max(0, relativePath.length - name.length - 1)) || '.',
          });
        }
      }
    }
    return hits.sort((a, b) => this.rank(a, b, needle)).slice(0, limit);
  }

  /** 搜聊天：在会话标签里做包含匹配。 */
  private searchChats(needle: string, limit: number): SearchHit[] {
    let sessions: ReturnType<WorkspaceSearchDeps['chats']>;
    try {
      sessions = this.deps.chats();
    } catch {
      return [];
    }
    return sessions
      .filter((session) => session.label.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((session) => ({
        kind: 'chat' as const,
        id: session.sessionId,
        label: session.label,
        hint: session.updatedAt,
      }));
  }

  /**
   * 命中排序：基名命中优先于路径命中，其次路径短的优先。
   * 前者贴合「我要找的就是这个文件」，后者让「根目录附近的入口文件」浮到上面，
   * 避免 `docs/legacy/2019/...` 这类长路径把真正的入口压下去。
   */
  private rank(a: SearchHit, b: SearchHit, needle: string): number {
    const aName = a.label.toLowerCase().includes(needle) ? 0 : 1;
    const bName = b.label.toLowerCase().includes(needle) ? 0 : 1;
    if (aName !== bName) return aName - bName;
    return a.id.length - b.id.length;
  }
}
