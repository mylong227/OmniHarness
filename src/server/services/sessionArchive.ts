import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Metrics } from './metrics.js';
import type { LocalDay } from '../../util/localDay.js';
import { SessionSidecars } from './sessionSidecars.js';
import { SessionRanking } from './sessionRanking.js';
import { SessionArchiveLayout } from '../../util/sessionArchiveLayout.js';
import { log } from '../../util/logger.js';
import { SessionFileScanner } from './sessionFileScanner.js';

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
  /** 是否已归档（侧车 `sessions.archived.json`；归档会话在 UI 里折叠到「已归档」组）。 */
  readonly archived: boolean;
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
  /** 侧车存储（自定义标题 / 归档名单 / 用户指定顺序）：细节见 {@link SessionSidecars}。 */
  private readonly sidecars: SessionSidecars;
  /** 本进程是否已做过遗留临时文件清扫（只做一次）。 */
  private sweptTempFiles = false;

  /**
   * @param deps 工作区根、存储位置、storageDir 覆盖与进程内指标
   */
  public constructor(deps: SessionArchiveDeps) {
    this.workspaceRoot = deps.workspaceRoot;
    this.storageLocation = deps.storageLocation;
    this.configuredStorageDir = deps.configuredStorageDir;
    this.metrics = deps.metrics;
    // 闭包**惰性**取目录：切换工作区后侧车路径自动跟随（与列表 / 用量同一口径）。
    this.sidecars = new SessionSidecars(() => this.storageLocation());
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
   *
   * **排序（v2，跨客户端成立）**：见 {@link SessionRanking} —— 新会话（上次排序之后出现的）置顶、
   * 用户显式排过的按名次、升级前的历史会话垫后；另一个客户端新建的会话因此不会被丢到列表底部。
   * @param includeArchived 是否连归档会话一起读（缺省 true，保持既有调用方行为；UI 的「已归档」组
   *   按需请求，日常列表可传 false 从而**跳过归档文件的逐个扫描**）
   * @returns `{ dir: string|undefined; sessions: SessionInfo[] }`
   */
  public list(includeArchived = true): unknown {
    const dir = this.storageLocation();
    if (dir === undefined || !existsSync(dir) || !statSync(dir).isDirectory()) {
      return { dir, sessions: [] };
    }
    // 每次进程生命周期内做一次**遗留临时文件清扫**（跨分区复制被打断留下的 `<dest>.<pid>.tmp`；
    // 按文件年龄判定，正在搬运的刚创建、不会被误删）。放在这里是因为它扫的就是本目录，
    // 且低频：一次 readdir + 最多几次 stat。见 {@link SessionArchiveLayout.sweepTempFiles}。
    if (!this.sweptTempFiles) {
      this.sweptTempFiles = true;
      const removed = SessionArchiveLayout.sweepTempFiles(dir);
      if (removed > 0) log.warn('session.temp_files.swept', { dir, removed });
    }
    const sessions: SessionInfo[] = [];
    const titles = this.sidecars.readTitles();
    const archivedSet = new Set(this.sidecars.readArchived());
    const push = (file: string, id: string, archived: boolean): void => {
      const parsed = this.scanSessionFile(file);
      if (parsed === undefined) return;
      const t = titles[id];
      sessions.push({
        sessionId: id,
        ...parsed,
        label: t !== undefined && t !== '' ? t : parsed.label,
        mtimeMs: SessionFileScanner.mtimeOf(file),
        archived,
      });
    };
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.replace(/\.jsonl$/, '');
      push(join(dir, name), id, archivedSet.has(id));
    }
    // 归档会话现在住在 `archive/` 子目录里：日常列表（includeArchived=false）**整个目录都不扫**，
    // 连事件流都不解析；「已归档」组按需请求时才读。
    if (includeArchived) {
      const archDir = SessionArchiveLayout.archiveDirOf(dir);
      if (existsSync(archDir) && statSync(archDir).isDirectory()) {
        for (const name of readdirSync(archDir)) {
          if (!name.endsWith('.jsonl')) continue;
          const id = name.replace(/\.jsonl$/, '');
          push(join(archDir, name), id, true);
        }
      }
    }
    const doc = this.sidecars.readOrderDoc();
    const keyed = sessions.map((s) => ({
      s,
      key: SessionRanking.sortKey(doc.rank[s.sessionId], s.mtimeMs, doc.at),
    }));
    keyed.sort((a, b) => SessionRanking.compare(a.key, b.key));
    return { dir, sessions: keyed.map((k) => k.s) };
  }

  /**
   * 归档 / 取消归档会话：**挪动文件**（主目录 ⇄ `archive/`，见 {@link SessionArchiveLayout}）并同步侧车
   * 名单。挪动用 `rename`，同分区原子 —— 任何时刻文件要么在主目录要么在归档目录，不存在中间态。
   * @param sessionId 会话 id
   * @param archived true 归档、false 恢复
   * @returns `{ ok }`；id 非法或存档不存在时 `{ ok:false, error }`
   */
  public setArchived(sessionId: string, archived: boolean): { ok: boolean; error?: string } {
    const dir = this.storageLocation();
    if (dir === undefined || this.resolveSessionFile(sessionId) === undefined) {
      return { ok: false, error: 'session_not_found' };
    }
    const move = archived
      ? SessionArchiveLayout.archive(dir, sessionId)
      : SessionArchiveLayout.restore(dir, sessionId);
    if (move === 'missing') return { ok: false, error: 'session_not_found' };
    const list = this.sidecars.readArchived();
    const next = archived
      ? [...new Set([...list, sessionId])]
      : list.filter((id) => id !== sessionId);
    this.sidecars.writeArchived(next);
    return { ok: true };
  }

  /**
   * 保存**用户指定顺序**（左栏拖拽排序的结果）：只登记传入的 id，其余会话仍按 mtime 倒序。
   * @param ids 有序会话 id 列表（未登记的会话排在其后）
   * @returns `{ ok }`；id 形态非法时 `{ ok:false, error }`
   */
  public reorder(ids: readonly string[]): { ok: boolean; error?: string } {
    const clean = ids.filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));
    if (clean.length !== ids.length) return { ok: false, error: 'bad_session_id' };
    const prev = this.sidecars.readOrderDoc();
    // 稠密名次 + 推进 `at`：此后新出现的会话会被判为「新会话」而置顶（跨客户端也成立）。
    this.sidecars.writeOrderDoc(SessionRanking.densify(clean, prev, Date.now()));
    return { ok: true };
  }

  /**
   * 校验会话 id 形态（仅字母数字下划线连字符，防路径穿越），并确保对应存档文件存在。
   * @param sessionId 待校验的会话 id
   * @returns 合法且存在时返回存档绝对路径，否则 undefined。
   */
  private resolveSessionFile(sessionId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return undefined;
    const dir = this.storageLocation();
    if (dir === undefined) return undefined;
    // 主目录优先，其次归档目录（归档会话仍可改名 / 删除 / 分叉 / 恢复）。
    return SessionArchiveLayout.find(dir, sessionId);
  }

  /**
   * 重命名会话：把自定义标题写入侧车 `sessions.meta.json`（空标题等价清除）。
   * 不改写事件流，列表读取时优先于首条用户消息作标签。
   * @param sessionId 会话 id
   * @param title 新标题（trim 后；空串清除自定义标题）
   * @returns `{ ok }`；id 非法或存档不存在时 `{ ok:false, error }`
   */
  public rename(sessionId: string, title: string): { ok: boolean; error?: string } {
    if (this.resolveSessionFile(sessionId) === undefined) {
      return { ok: false, error: 'session_not_found' };
    }
    const map = this.sidecars.readTitles();
    const t = title.trim();
    if (t === '') delete map[sessionId];
    else map[sessionId] = t.slice(0, 200);
    this.sidecars.writeTitles(map);
    return { ok: true };
  }

  /**
   * 删除会话：移除存档 .jsonl 与侧车标题条目；运行中的会话拒绝删除（防竞态截断活动流）。
   * @param sessionId 会话 id
   * @returns `{ ok }`；id 非法、存档缺失或会话运行中时 `{ ok:false, error }`
   */
  public delete(sessionId: string): { ok: boolean; error?: string } {
    const file = this.resolveSessionFile(sessionId);
    if (file === undefined) return { ok: false, error: 'session_not_found' };
    if (this.isRunning(sessionId)) return { ok: false, error: 'session_running' };
    rmSync(file, { force: true });
    const map = this.sidecars.readTitles();
    if (map[sessionId] !== undefined) {
      delete map[sessionId];
      this.sidecars.writeTitles(map);
    }
    return { ok: true };
  }

  /**
   * 分叉会话：复制存档 .jsonl 为新 id，并追加 `session_meta.forkedFrom` 事件，
   * 使新会话在列表中继承原内容（标签仍取首条用户消息）。
   * @param sessionId 源会话 id
   * @returns `{ ok, newSessionId }`；失败时 `{ ok:false, error }`
   */
  public fork(sessionId: string): { ok: boolean; newSessionId?: string; error?: string } {
    const file = this.resolveSessionFile(sessionId);
    if (file === undefined) return { ok: false, error: 'session_not_found' };
    const newId = randomUUID().replace(/-/g, '');
    const dest = join(this.storageLocation() as string, `${newId}.jsonl`);
    copyFileSync(file, dest);
    const meta = JSON.stringify({
      type: 'session_meta',
      timestamp: new Date().toISOString(),
      payload: { forkedFrom: sessionId },
    });
    appendFileSync(dest, '\n' + meta, 'utf8');
    return { ok: true, newSessionId: newId };
  }

  /**
   * 判断某会话是否正在运行（由外部运行态派生；默认 false，子类/宿主可覆盖）。
   * 基类无运行态感知，由 `AppServer` 通过 {@link setRunningChecker} 注入真实判定。
   * @param _sessionId 会话 id（基类忽略）
   * @returns 是否运行中。
   */
  private runningChecker: (sessionId: string) => boolean = () => false;

  /**
   * 注入运行态判定（宿主在构造后调用，避免循环依赖）。
   * @param checker `(sessionId) => boolean` 真实运行态判定
   * @returns 无返回值。
   */
  public setRunningChecker(checker: (sessionId: string) => boolean): void {
    this.runningChecker = checker;
  }

  /**
   * 委托运行态判定。
   * @param sessionId 会话 id
   * @returns 是否运行中。
   */
  private isRunning(sessionId: string): boolean {
    return this.runningChecker(sessionId);
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
      const ev = SessionFileScanner.parseLine(line);
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
      const ev = SessionFileScanner.parseLine(line);
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
  private scanSessionFile(
    file: string,
  ): Omit<SessionInfo, 'sessionId' | 'mtimeMs' | 'archived'> | undefined {
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
      const ev = SessionFileScanner.parseLine(line);
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
