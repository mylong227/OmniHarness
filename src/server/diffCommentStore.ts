import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { id } from '../util/id.js';
import type { RepoPathGuard } from './repoPathGuard.js';

/** diff 行内评论记录（锚定 文件 + 行号 + 侧别），持久化在工作区 .omni/diff-comments.json。 */
export interface DiffCommentRecord {
  id: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  text: string;
  ts: string;
}

/** DiffCommentStore 构造选项。 */
export interface DiffCommentStoreOptions {
  /** 当前工作区根 getter（兼容运行时切换工作区）。 */
  readonly workspaceRoot: () => string;
  /** 仓库内相对路径守卫。 */
  readonly guard: RepoPathGuard;
}

/**
 * 行内 diff 评论持久化：工作区级 JSON 文件（`.omni/diff-comments.json`），
 * 与 `.omni-checkpoints` 同一约定——藏在 `.omni/` 下，不污染用户仓库。
 *
 * 读取失败 fail-open 到空态（不阻断 UI）；写入前对每条记录做结构校验，
 * 拒绝损坏行，避免半截数据污染列表。
 */
export class DiffCommentStore {
  /**
   * @param options 工作区根 getter 与路径守卫。
   */
  public constructor(private readonly options: DiffCommentStoreOptions) {}

  /**
   * 列出全部行内评论。
   * @returns `{ comments: DiffCommentRecord[] }`。
   */
  public list(): unknown {
    return { comments: this.load() };
  }

  /**
   * 新增一条行内评论。
   * @param params RPC 参数，需非空 `path` 与非空 `text`，以及非负整数 `line`；可选 `side`（old/new）。
   * @returns `{ ok: true, comment }`。
   * @throws path/text 非法、line 非非负整数，或路径越出仓库范围时。
   */
  public add(params: Record<string, unknown>): unknown {
    const rawPath = params['path'];
    const text = params['text'];
    const line = params['line'];
    if (typeof rawPath !== 'string' || typeof text !== 'string' || text.trim() === '') {
      throw new Error('changes.comments.add 需要非空 path 与 text');
    }
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
      throw new Error('changes.comments.add 需要非负整数 line');
    }
    const side: 'old' | 'new' = params['side'] === 'old' ? 'old' : 'new';
    const rel = this.options.guard.resolve(rawPath);
    const comment: DiffCommentRecord = {
      id: id('cmt'),
      path: rel,
      side,
      line,
      text: text.trim(),
      ts: new Date().toISOString(),
    };
    const list = this.load();
    list.push(comment);
    this.save(list);
    return { ok: true, comment };
  }

  /**
   * 删除一条行内评论。
   * @param params RPC 参数，需 `id`。
   * @returns `{ ok: true }`。
   * @throws id 缺失或未找到对应评论时。
   */
  public remove(params: Record<string, unknown>): unknown {
    const idParam = params['id'];
    if (typeof idParam !== 'string') throw new Error('changes.comments.delete 需要 id');
    const list = this.load();
    const next = list.filter((c) => c.id !== idParam);
    if (next.length === list.length) {
      throw new Error('未找到评论: ' + idParam);
    }
    this.save(next);
    return { ok: true };
  }

  /**
   * 评论持久化文件路径（工作区级）。
   * @returns `.omni/diff-comments.json` 的绝对路径。
   */
  private file(): string {
    return join(this.options.workspaceRoot(), '.omni', 'diff-comments.json');
  }

  /**
   * 读取全部行内评论。
   * @returns 结构合法的评论数组；文件缺失/损坏时返回空数组（fail-open）。
   */
  private load(): DiffCommentRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file(), 'utf8'));
      if (!Array.isArray(parsed)) return [];
      const out: DiffCommentRecord[] = [];
      for (const item of parsed) {
        const c = item as Partial<DiffCommentRecord>;
        if (
          typeof c.id === 'string' &&
          typeof c.path === 'string' &&
          (c.side === 'old' || c.side === 'new') &&
          typeof c.line === 'number' &&
          typeof c.text === 'string' &&
          typeof c.ts === 'string'
        ) {
          out.push({ id: c.id, path: c.path, side: c.side, line: c.line, text: c.text, ts: c.ts });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 覆盖写入全部行内评论（自动创建 `.omni/` 目录）。
   * @param list 待写入的评论列表。
   */
  private save(list: readonly DiffCommentRecord[]): void {
    const file = this.file();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  }
}
