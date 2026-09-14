import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Metrics } from './metrics.js';
import type { LocalDay } from '../../util/localDay.js';

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
  readonly workspace?: string | undefined;
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
  readonly metrics?: Metrics | undefined;
}

/**
 * 会话存档读取服务：按 `.jsonl` 存档聚合 token 用量（usage.stats）与列出会话（sessions.list）。
 *
 * 只读，不写入任何存档；磁盘无数据时 usage 回退进程内 `Metrics` 快照（诚实标注 source，
 * 不混算，避免重启后双计）。会话列表提取 `session_meta` 工作区标记与首条用户消息作标签，
 * 供 UI 按项目收纳。
 */
export class SessionArchive {
  /** 当前生效工作区根（fallback 存储目录的相对基准）。 */
  private readonly workspaceRoot: () => string;
  /** StoragePort 存档位置（实时求值，切换工作区后跟随）。 */
  private readonly storageLocation: () => string | undefined;
  /** 配置文件里的 storageDir 覆盖（usage 的 fallback 用）。 */
  private readonly configuredStorageDir: () => string | undefined;
  /** 进程内指标（磁盘无历史时回退）。 */
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
          sessions.push({
            sessionId: name.replace(/\.jsonl$/, ''),
            calls: scanned.calls,
            total: scanned.total,
          });
        }
      }
    }

    if (sessions.length > 0) {
      sessions.sort((a, b) => b.total - a.total);
      return {
        source: 'disk',
        dir,
        byModel: Object.fromEntries(byModel),
        total: SessionArchive.sumStats(byModel.values()),
        sessions,
      };
    }

    // 回退：磁盘无历史（新装/存储为 memory），用进程内累计（重启清零）。
    const live = this.metrics?.snapshot().tokens ?? {};
    return {
      source: 'live',
      dir,
      byModel: live,
      total: SessionArchive.sumStats(Object.values(live)),
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
      sessions.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        ...parsed,
        mtimeMs: SessionArchive.mtimeOf(join(dir, name)),
      });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { dir, sessions };
  }

  /**
   * 按「本地自然日」聚合 token 用量（配额面板用）。
   *
   * 与 {@link SessionArchive.usage} 的差别：usage 聚合全量历史并按模型分组，
   * 本方法只看**某一天**，因为「今日余额」的语义边界是本地日历日（重置点 23:59），
   * 不是滚动 24 小时——用滚动窗口会让余额在深夜悄悄回升，用户无法预期。
   *
   * 时间戳按事件自带的 ISO 串解析后转本地时区取日期：直接截字符串前 10 位会按 UTC 归日，
   * 东八区用户在 08:00 前的用量会被记到前一天。归属判定统一走 {@link LocalDay}。
   *
   * @param day 目标本地自然日（由调用方按同一时区构造）
   * @returns `{ byModel, total }`：各模型当日 token 数（prompt + completion）与总和
   */
  public dailyUsage(day: LocalDay): { byModel: Record<string, number>; total: number } {
    const dir = this.usageDir();
    const byModel = new Map<string, number>();
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        this.scanDayFile(join(dir, name), day, byModel);
      }
    }
    const out: Record<string, number> = {};
    let total = 0;
    for (const [model, tokens] of byModel) {
      out[model] = tokens;
      total += tokens;
    }
    return { byModel: out, total };
  }

  /**
   * 扫描单个存档中属于该自然日的 model 事件，累加 token 到 byModel。
   * @param file 存档文件路径。
   * @param day 目标本地自然日。
   * @param byModel 模型 → token 累计表（原地累加）。
   * @returns 无返回值（文件不可读静默跳过）。
   */
  private scanDayFile(file: string, day: LocalDay, byModel: Map<string, number>): void {
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      return;
    }
    for (const line of lines) {
      const ev = SessionArchive.parseLine(line);
      if (ev?.type !== 'model') continue;
      if (!day.contains(ev.timestamp)) continue;
      const usage = ev.payload?.['usage'] as Record<string, unknown> | undefined;
      if (usage === undefined) continue;
      const tokens = Number(usage['promptTokens'] ?? 0) + Number(usage['completionTokens'] ?? 0);
      if (!Number.isFinite(tokens) || tokens <= 0) continue;
      const model = ev.payload?.['model'];
      const key = typeof model === 'string' && model !== '' ? model : 'unknown';
      byModel.set(key, (byModel.get(key) ?? 0) + tokens);
    }
  }

  /**
   * usage 的扫描目录：StoragePort.location 优先，否则按工作区 + storageDir 推断。
   * @returns 存档目录路径。
   */
  private usageDir(): string {
    return (
      this.storageLocation() ??
      resolve(this.workspaceRoot(), this.configuredStorageDir() ?? DEFAULT_SESSIONS_DIR)
    );
  }

  /**
   * 扫描单个存档的 model 事件，累加进 byModel，返回本文件 calls/total。
   * @param file 存档文件路径。
   * @param byModel 模型统计表（原地累加）。
   * @returns 本文件的调用次数与 token 总量（不可读时全零）。
   */
  private scanUsageFile(
    file: string,
    byModel: Map<string, ModelStat>,
  ): { calls: number; total: number } {
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      return { calls: 0, total: 0 };
    }
    let calls = 0;
    let total = 0;
    for (const line of lines) {
      const ev = SessionArchive.parseLine(line);
      if (ev?.type !== 'model') continue;
      const usage = ev.payload?.['usage'];
      if (usage === undefined) continue;
      const rec = usage as Record<string, unknown>;
      const p = Number(rec['promptTokens'] ?? 0);
      const c = Number(rec['completionTokens'] ?? 0);
      const model = ev.payload?.['model'];
      SessionArchive.bump(byModel, typeof model === 'string' ? model : 'unknown', p, c);
      calls += 1;
      total += p + c;
    }
    return { calls, total };
  }

  /**
   * 解析单个存档的 session_meta/user 事件；文件不可读返回 undefined。
   * @param file 存档文件路径。
   * @returns 工作区标记、标签（首条用户消息前 80 字）、回合数与最后更新时间；不可读时 undefined。
   */
  private scanSessionFile(file: string): Omit<SessionInfo, 'sessionId' | 'mtimeMs'> | undefined {
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
      const ev = SessionArchive.parseLine(line);
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

  /**
   * 解析一行 JSONL；空行/坏行/非对象返回 undefined。
   * @param line 单行文本
   * @returns 解析出的事件对象；空行/坏行/非对象返回 undefined
   */
  private static parseLine(
    line: string,
  ): { type?: string; timestamp?: string; payload?: Record<string, unknown> } | undefined {
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

  /**
   * 累加某模型的 token 统计（不可变更新）。
   * @param map 模型统计表（原地累加）
   * @param model 模型名
   * @param p prompt token 数
   * @param c completion token 数
   * @returns 无返回值（map 原地累加）
   */
  private static bump(map: Map<string, ModelStat>, model: string, p: number, c: number): void {
    const prev = map.get(model) ?? { calls: 0, prompt: 0, completion: 0, total: 0 };
    map.set(model, {
      calls: prev.calls + 1,
      prompt: prev.prompt + p,
      completion: prev.completion + c,
      total: prev.total + p + c,
    });
  }

  /**
   * 汇总一组模型统计。
   * @param values 模型统计迭代
   * @returns 汇总后的总统计（calls/prompt/completion/total）
   */
  private static sumStats(values: Iterable<ModelStat>): ModelStat {
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

  /**
   * 文件 mtime（毫秒）；消失竞态回退 0。
   * @param file 文件路径
   * @returns 修改时间毫秒；消失竞态回退 0
   */
  private static mtimeOf(file: string): number {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }
}
