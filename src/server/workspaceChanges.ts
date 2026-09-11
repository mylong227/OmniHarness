import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SessionEvent } from '../ports/event.js';

/** 单文件变更统计。 */
interface ChangeStat {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
}

/** 工作区变更服务依赖（窄接口注入，便于独立单测）。 */
export interface WorkspaceChangesDeps {
  /** 当前生效工作区根。 */
  readonly workspaceRoot: () => string;
  /** 已知线程 id 集合（非 git 回退时遍历）。 */
  readonly threadIds: () => Iterable<string>;
  /** 回放某线程的全部事件（非 git 回退时读 turn_diff）。 */
  readonly replay: (threadId: string) => Promise<readonly SessionEvent[]>;
}

/**
 * 工作区变更清单服务（git 式）：工作区是 git 仓库时用 `git status --porcelain` +
 * `git diff --numstat HEAD` 产出真实变更清单，并支持单文件 patch（`params.path`）；
 * 非 git 工作区回退聚合已知线程 `turn_diff` 事件里的 per 文件增删行数。
 *
 * 三段实现（`list` / `gitChanges` / `sessionChanges`）在本类内闭环，不触达 Agent 状态。
 */
export class WorkspaceChanges {
  private readonly workspaceRoot: () => string;
  private readonly threadIds: () => Iterable<string>;
  private readonly replay: (threadId: string) => Promise<readonly SessionEvent[]>;

  /**
   * @param deps 工作区根 + 线程枚举 + 事件回放
   */
  public constructor(deps: WorkspaceChangesDeps) {
    this.workspaceRoot = deps.workspaceRoot;
    this.threadIds = deps.threadIds;
    this.replay = deps.replay;
  }

  /**
   * 工作区变更记录 RPC：git 仓库优先，否则回退会话 turn_diff 聚合。
   * @param params `{ path?: string }`，传入时返回该文件 patch
   * @returns git 或 session 来源的变更清单 / 单文件 patch
   */
  public async list(params: Record<string, unknown>): Promise<unknown> {
    const ws = this.workspaceRoot();
    const fileParam = typeof params['path'] === 'string' ? params['path'] : undefined;
    const git = this.gitChanges(ws, fileParam);
    if (git !== null) return git;
    return this.sessionChanges(ws, fileParam);
  }

  /** git 仓库变更：返回 null 表示不是 git 仓库（或 git 不可用）。 */
  private gitChanges(ws: string, fileParam: string | undefined): unknown | null {
    if (!isGitWorkTree(ws)) return null;
    return fileParam !== undefined ? this.gitFilePatch(ws, fileParam) : this.gitFileList(ws);
  }

  /** 单文件 patch：已跟踪用 `git diff HEAD`；未跟踪（??）直接读文件构造全 + patch。 */
  private gitFilePatch(ws: string, fileParam: string): unknown {
    const status = spawnSync('git', ['status', '--porcelain', '--', fileParam], {
      cwd: ws,
      encoding: 'utf8',
    });
    if (status.stdout.startsWith('??')) {
      let content = '';
      try {
        content = readFileSync(resolve(ws, fileParam), 'utf8');
      } catch {
        content = '';
      }
      const body = content
        .split('\n')
        .map((l) => '+' + l)
        .join('\n');
      return { source: 'git', patch: `--- /dev/null\n+++ ${fileParam}\n${body}` };
    }
    const diff = spawnSync('git', ['diff', 'HEAD', '--', fileParam], { cwd: ws, encoding: 'utf8' });
    return { source: 'git', patch: diff.status === 0 ? diff.stdout : '' };
  }

  /** 整仓变更清单：branch + per 文件增删行数。 */
  private gitFileList(ws: string): unknown {
    const branch = gitLine(ws, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: ws, encoding: 'utf8' });
    if (status.status !== 0) return { source: 'git', branch, files: [] };
    const numstat = spawnSync('git', ['diff', '--numstat', 'HEAD'], { cwd: ws, encoding: 'utf8' });
    const stats = parseNumstat(numstat.stdout ?? '');
    const files: ChangeStat[] = status.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((line) => toChangeStat(line, stats, ws));
    return { source: 'git', branch, files };
  }

  /**
   * 非 git 工作区回退：聚合已知线程 turn_diff 事件，按 unified diff 的 `diff --git`
   * 分段解析出 per 文件增删行数；`fileParam` 传入时返回该文件的原始 patch 拼接。
   */
  private async sessionChanges(ws: string, fileParam: string | undefined): Promise<unknown> {
    void ws;
    const sections = new Map<string, string[]>();
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const threadId of this.threadIds()) {
      let events: readonly SessionEvent[] = [];
      try {
        events = await this.replay(threadId);
      } catch {
        continue;
      }
      for (const ev of events) {
        if (ev.type !== 'turn_diff') continue;
        collectTurnDiff((ev.payload as { diff?: string } | undefined)?.diff ?? '', sections, stats);
      }
    }
    if (fileParam !== undefined) {
      return { source: 'session', patch: (sections.get(fileParam) ?? []).join('\n') };
    }
    return {
      source: 'session',
      files: [...stats.entries()].map(([path, s]) => ({
        path,
        status: 'M',
        additions: s.additions,
        deletions: s.deletions,
      })),
    };
  }
}

/** 工作区是否为 git 工作树。 */
function isGitWorkTree(ws: string): boolean {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ws, encoding: 'utf8' });
  return inside.status === 0 && inside.stdout.trim() === 'true';
}

/** 运行 git 子命令并返回去除首尾空白的 stdout。 */
function gitLine(cwd: string, args: readonly string[]): string {
  return spawnSync('git', [...args], { cwd, encoding: 'utf8' }).stdout.trim();
}

/** 解析 `git diff --numstat` 输出为 path → 增删行数。 */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [add, del, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (path === '') continue;
    stats.set(path, {
      additions: add === '-' ? 0 : Number(add),
      deletions: del === '-' ? 0 : Number(del),
    });
  }
  return stats;
}

/** 把一行 porcelain 输出转为 ChangeStat（补齐 numstat 缺失的增删行数）。 */
function toChangeStat(
  line: string,
  stats: Map<string, { additions: number; deletions: number }>,
  ws: string,
): ChangeStat {
  const status = line.slice(0, 2).trim() || 'M';
  let path = line.slice(3).trim();
  // 重命名格式 "old -> new"：以新路径为准。
  if (path.includes(' -> ')) path = path.split(' -> ').pop() ?? path;
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  const known = stats.get(path);
  if (known !== undefined) {
    return { path, status, additions: known.additions, deletions: known.deletions };
  }
  if (status === 'A' || status === '??') {
    // 新增文件：numstat 不含未跟踪，按行数记 +
    return { path, status, additions: countLines(ws, path), deletions: 0 };
  }
  return { path, status, additions: 0, deletions: 0 };
}

/** 读取文件行数（读不到回退 0）。 */
function countLines(ws: string, path: string): number {
  try {
    return readFileSync(resolve(ws, path), 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}

/** 把单段 unified diff 按文件切分累加进 sections / stats。 */
function collectTurnDiff(
  diff: string,
  sections: Map<string, string[]>,
  stats: Map<string, { additions: number; deletions: number }>,
): void {
  let path = '';
  let body: string[] = [];
  let add = 0;
  let del = 0;
  const flush = (): void => {
    if (path === '') return;
    const prev = stats.get(path) ?? { additions: 0, deletions: 0 };
    stats.set(path, { additions: prev.additions + add, deletions: prev.deletions + del });
    const list = sections.get(path) ?? [];
    list.push(body.join('\n'));
    sections.set(path, list);
    path = '';
    body = [];
    add = 0;
    del = 0;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      flush();
    } else if (line.startsWith('+++ ')) {
      path = line.slice(4).replace(/^b\//, '').trim();
      body.push(line);
    } else if (path !== '') {
      body.push(line);
      if (line.startsWith('+')) add += 1;
      else if (line.startsWith('-')) del += 1;
    }
  }
  flush();
}
