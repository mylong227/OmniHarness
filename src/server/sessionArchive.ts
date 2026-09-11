import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Metrics } from './metrics.js';

/** 会话存档默认子目录（相对工作区）。 */
const DEFAULT_SESSIONS_DIR = '.omniharness/sessions';

/** 单模型 token 统计。 */
interface ModelStat {
  readonly calls: number;
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

/** 会话列表条目。 */
interface SessionInfo {
  readonly sessionId: string;
  readonly workspace?: string;
  readonly label: string;
  readonly turns: number;
  readonly updatedAt: string;
  readonly mtimeMs: number;
}

/** 会话存档读取依赖。 */
export interface SessionArchiveDeps {
  /** 当前生效工作区根（fallback 存储目录的相对基准）。 */
  readonly workspaceRoot: () => string;
  /** StoragePort.location：物理存档目录（sqlite 等非文件后端时为非 jsonl 目录）；切换工作区后实时求值。 */
  readonly storageLocation: () => string | undefined;
  /** 配置文件里的 storageDir 覆盖（usage 的 fallback 用）。 */
  readonly configuredStorageDir: () => string | undefined;
  /** 进程内指标（磁盘无历史时回退）。 */
  readonly metrics?: Metrics;
}

/**
 * 会话存档读取服务：按 `.jsonl` 存档聚合 token 用量（usage.stats）与列出会话（sessions.list）。
 *
 * 只读，不写入任何存档；磁盘无数据时 usage 回退进程内 `Metrics` 快照（诚实标注 source，
 * 不混算，避免重启后双计）。会话列表提取 `session_meta` 工作区标记与首条用户消息作标签，
 * 供 UI 按项目收纳。
 */
export class SessionArchive {
  private readonly workspaceRoot: () => string;
  private readonly storageLocation: () => string | undefined;
  private readonly configuredStorageDir: () => string | undefined;
  private readonly metrics: Metrics | undefined;

  /**
   * @param deps 工作区根、存储位置、storageDir 覆盖与进程内指标
   */
  public constructor(deps: SessionArchiveDeps) {
    this.workspaceRoot = deps.workspaceRoot;
    this.storageLocation = deps.storageLocation;
    this.configuredStorageDir = deps.configuredStorageDir;
    this.metrics = deps.metrics;
  }

  /**
   * Token 消耗统计 RPC：扫描会话存储目录（每会话一个 .jsonl）聚合 type='model' 事件，
   * 按模型与会话分组返回调用次数 / prompt / completion / total。磁盘无数据时回退
   * 进程内 metrics（诚实标注来源）。
   * @returns `{ source:'disk'|'live'; dir; byModel; total; sessions }`
   */
  public usage(): unknown {
    const dir = this.usageDir();
    const byModel = new Map<string, ModelStat>();
    const sessions: { sessionId: string; calls: number; total: number }[] = [];

    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const scanned = this.scanUsageFile(join(dir, name), byModel);
        if (scanned.calls > 0) {
          sessions.push({ sessionId: name.replace(/\.jsonl$/, ''), calls: scanned.calls, total: scanned.total });
        }
      }
    }

    if (sessions.length > 0) {
      sessions.sort((a, b) => b.total - a.total);
      return {
        source: 'disk',
        dir,
        byModel: Object.fromEntries(byModel),
        total: sumStats(byModel.values()),
        sessions,
      };
    }

    // 回退：磁盘无历史（新装/存储为 memory），用进程内累计（重启清零）。
    const live = this.metrics?.snapshot().tokens ?? {};
    return {
      source: 'live',
      dir,
      byModel: live,
      total: sumStats(Object.values(live)),
      sessions: [],
    };
  }

  /**
   * 会话列表 RPC：扫描 StoragePort 实际位置下全部会话存档，提取工作区标记
   * （session_meta 事件）与首条用户消息（作标签），供 UI 按项目收纳、切换项目查看对应会话。
   * 无标记的历史会话 workspace 为 undefined，UI 归入「更早会话」组。
   * @returns `{ dir: string|undefined; sessions: SessionInfo[] }`（按 mtime 倒序）
   */
  public list(): unknown {
    const dir = this.storageLocation();
    if (dir === undefined || !existsSync(dir) || !statSync(dir).isDirectory()) {
      return { dir, sessions: [] };
    }
    const sessions: SessionInfo[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const parsed = this.scanSessionFile(join(dir, name));
      if (parsed === undefined) continue;
      sessions.push({ sessionId: name.replace(/\.jsonl$/, ''), ...parsed, mtimeMs: mtimeOf(join(dir, name)) });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { dir, sessions };
  }

  /** usage 的扫描目录：StoragePort.location 优先，否则按工作区 + storageDir 推断。 */
  private usageDir(): string {
    return (
      this.storageLocation() ??
      resolve(this.workspaceRoot(), this.configuredStorageDir() ?? DEFAULT_SESSIONS_DIR)
    );
  }

  /** 扫描单个存档的 model 事件，累加进 byModel，返回本文件 calls/total。 */
  private scanUsageFile(file: string, byModel: Map<string, ModelStat>): { calls: number; total: number } {
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      return { calls: 0, total: 0 };
    }
    let calls = 0;
    let total = 0;
    for (const line of lines) {
      const ev = parseLine(line);
      if (ev?.type !== 'model') continue;
      const usage = ev.payload?.['usage'];
      if (usage === undefined) continue;
      const rec = usage as Record<string, unknown>;
      const p = Number(rec['promptTokens'] ?? 0);
      const c = Number(rec['completionTokens'] ?? 0);
      const model = ev.payload?.['model'];
      bump(byModel, typeof model === 'string' ? model : 'unknown', p, c);
      calls += 1;
      total += p + c;
    }
    return { calls, total };
  }

  /** 解析单个存档的 session_meta/user 事件；文件不可读返回 undefined。 */
  private scanSessionFile(
    file: string,
  ): Omit<SessionInfo, 'sessionId' | 'mtimeMs'> | undefined {
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      return undefined;
    }
    let workspace: string | undefined;
    let label = '';
    let turns = 0;
    let updatedAt = '';
    for (const line of lines) {
      const ev = parseLine(line);
      if (ev === undefined) continue;
      if (ev.type === 'session_meta' && typeof ev.payload?.['workspace'] === 'string') {
        workspace = ev.payload['workspace'] as string;
      } else if (ev.type === 'user') {
        if (label === '') {
          const content = ev.payload?.['content'];
          if (typeof content === 'string') label = content.slice(0, 80);
        }
        turns += 1;
      }
      if (typeof ev.timestamp === 'string') updatedAt = ev.timestamp;
    }
    return { workspace, label, turns, updatedAt };
  }
}

/** 解析一行 JSONL；空行/坏行/非对象返回 undefined。 */
function parseLine(line: string): { type?: string; timestamp?: string; payload?: Record<string, unknown> } | undefined {
  if (line.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  return parsed as { type?: string; timestamp?: string; payload?: Record<string, unknown> };
}

/** 累加某模型的 token 统计（不可变更新）。 */
function bump(map: Map<string, ModelStat>, model: string, p: number, c: number): void {
  const prev = map.get(model) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
  map.set(model, {
    calls: prev.calls + 1,
    prompt: prev.prompt + p,
    completion: prev.completion + c,
    total: prev.total + p + c,
  });
}

/** 汇总一组模型统计。 */
function sumStats(values: Iterable<ModelStat>): ModelStat {
  const total: { calls: number; prompt: number; completion: number; total: number } = {
    calls: 0,
    prompt: 0,
    completion: 0,
    total: 0,
  };
  for (const m of values) {
    total.calls += m.calls;
    total.prompt += m.prompt;
    total.completion += m.completion;
    total.total += m.total;
  }
  return total;
}

/** 文件 mtime（毫秒）；消失竞态回退 0。 */
function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
