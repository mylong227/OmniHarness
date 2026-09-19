/**
 * 只读 trace 自省服务（SessionTraceService）——把「读 trace」接进真实生产路径。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`ports/intelligence/traceIntrospection.ts`（端口）与
 * `adapters/telemetry/readonlyTraceReader.ts`（只读投影实现）写了、有单测，却**没有任何生产接线点**
 * ——agent 想自查「我刚做了什么」没有可达入口。本服务是那段接线的落点：
 *
 * - 事件来源注入（`replay`）：服务端注入 `Agent.replay`（实时运行态），CLI 注入
 *   `SessionEventReader`（落盘存档），两条入口共用**同一个端口实现**（{@link ReadonlyTraceReader}）；
 * - 只读保证不变：条目由读取器深拷贝 + 冻结后返回，调用方无法借道改历史；
 * - fail-soft：事件源抛错（存储瞬断等）时返回带 `error` 的空快照，绝不把异常抛给自省调用方。
 */
import { ReadonlyTraceReader } from '../../adapters/telemetry/readonlyTraceReader.js';
import type { SessionEvent } from '../../ports/runtime/event.js';
import type {
  TraceEntry,
  TraceFilter,
  TraceReadRequest,
  TraceReadResult,
} from '../../ports/intelligence/traceIntrospection.js';

/** 会话事件源（服务端为 Agent.replay，CLI 为存档读取器）。 */
export interface SessionTraceReplay {
  /**
   * 取某会话的事件流。
   * @param sessionId 会话 id
   * @returns 该会话的事件流（按写入序）；会话不存在时为空数组
   */
  (sessionId: string): Promise<readonly SessionEvent[]>;
}

/** SessionTraceService 依赖。 */
export interface SessionTraceServiceDeps {
  /** 会话事件源（getter 注入；通常为 `(id) => agent.replay(id)`）。 */
  readonly replay: SessionTraceReplay;
  /**
   * 会话存在性判定（须为真判定）。
   *
   * 为什么必须显式注入：会话存储端口只有 `load()`，而它对**不存在的会话**与**零事件的会话**
   * 一律返回空数组（`JsonlStorage` / `SqliteStorage` 都是这个契约，服务端 `Agent.replay` 亦然）。
   * 没有本判定，服务只能把两者混为一谈，正是「有实现、无接线」要消灭的那类含糊。
   * 缺省为恒真（事件源自身报错时仍由 load 的 fail-soft 分支兜住）。
   */
  readonly exists?: ((sessionId: string) => Promise<boolean>) | undefined;
  /** 失败记录器（缺省静默；生产注入 stderr 或日志端口）。 */
  readonly logError?: ((message: string) => void) | undefined;
}

/** 已加载会话的事件单元（provider 闭包持有它，load 时原地替换内容）。 */
interface TraceCell {
  events: readonly SessionEvent[];
}

/**
 * 只读 trace 自省服务：按会话把事件流投影为冻结条目，并做「加载 + 查询」两段式分离。
 *
 * 两段式是刻意的：`ReadonlyTraceReader` 的事件源是**同步 getter**（跟随 recorder 实时视图），
 * 而会话事件要经异步存储读回。故 `load()` 负责把事件拉进缓存单元，`read()` 再从缓存同步投影。
 * 缓存以会话 id 为键、FIFO 上限 {@link SessionTraceService.MAX_SESSIONS} 条，防止长驻服务无界增长。
 */
export class SessionTraceService {
  /** 缓存会话上限（超出按插入序淘汰最旧一个）。 */
  private static readonly MAX_SESSIONS = 16;
  /** 单次读取条数上限（防止消费方一次拉爆内存）。 */
  private static readonly MAX_LIMIT = 500;
  /** 单次读取默认条数（与端口默认一致）。 */
  private static readonly DEFAULT_LIMIT = 20;
  /** 事件源。 */
  private readonly replay: SessionTraceReplay;
  /** 会话存在性判定（真判定；缺省恒真）。 */
  private readonly exists: (sessionId: string) => Promise<boolean>;
  /** 失败记录器。 */
  private readonly logError: (message: string) => void;
  /** 已加载会话（会话 id → 事件单元，FIFO 淘汰）。 */
  private readonly cells = new Map<string, TraceCell>();
  /** 会话 id → 只读投影器（与 cells 同步增删，保证同一会话复用同一端口实现实例）。 */
  private readonly readers = new Map<string, ReadonlyTraceReader>();

  /**
   * @param deps 事件源、存在性判定与失败记录器
   */
  public constructor(deps: SessionTraceServiceDeps) {
    this.replay = deps.replay;
    this.exists = deps.exists ?? (async () => true);
    this.logError = deps.logError ?? (() => undefined);
  }

  /**
   * 加载（或复用）某会话的事件流进缓存。
   * @param sessionId 会话 id
   * @returns 事件条数；会话不存在 / 事件源抛错时为 0（fail-soft，异常不外抛）
   */
  public async load(sessionId: string): Promise<number> {
    try {
      if (!(await this.exists(sessionId))) {
        return 0;
      }
      const cell: TraceCell = this.cells.get(sessionId) ?? { events: [] };
      const events = await this.replay(sessionId);
      cell.events = events;
      // 只有真读到事件流（哪怕为空数组 = 会话存在但无事件）才登记缓存：
      // 未登记的会话在 read() 里如实报「未找到」，不会被误当成「读到了 0 条」。
      this.install(sessionId, cell);
      return events.length;
    } catch (error) {
      this.logError(
        `trace 事件源读取失败（session=${sessionId}）: ${SessionTraceService.messageOf(error)}`,
      );
      return 0;
    }
  }

  /**
   * 某会话是否已加载进只读缓存。
   * @param sessionId 会话 id
   * @returns 已加载（可 read）为 true
   */
  public has(sessionId: string): boolean {
    return this.readers.has(sessionId);
  }

  /**
   * 读取某会话的只读 trace 条目（新在前）。
   * @param request 查询（会话 id + 可选 limit / kind）
   * @returns 冻结条目快照 + 计数；会话不存在 / 未加载时 entries 为空且 error 说明原因
   */
  public read(request: TraceReadRequest): TraceReadResult {
    const session = request.session;
    if (session.trim() === '') {
      return { session, entries: [], count: 0, error: 'trace.read 需要非空 sessionId' };
    }
    const reader = this.readers.get(session);
    if (reader === undefined) {
      return { session, entries: [], count: 0, error: `会话未找到或无 trace: ${session}` };
    }
    const entries = this.project(reader, { limit: request.limit, kind: request.kind });
    return { session, entries, count: entries.length };
  }

  /**
   * 投影：有 kind 走 byKind，否则走 recent；条数钳到 [1, MAX_LIMIT]。
   * @param reader 已加载会话的只读投影器
   * @param filter 过滤条件（limit / kind）
   * @returns 冻结条目快照（新在前）
   */
  private project(reader: ReadonlyTraceReader, filter: TraceFilter): readonly TraceEntry[] {
    const limit = SessionTraceService.clampLimit(filter.limit);
    const kind = filter.kind;
    return kind !== undefined && kind !== '' ? reader.byKind(kind, limit) : reader.recent(limit);
  }

  /**
   * 装配事件单元与只读投影器（同会话复用同一读取器；provider 闭包指向单元，load 后即见新内容）。
   * @param sessionId 会话 id
   * @param cell 事件单元（可为既有单元，保证重复 load 不丢已读内容）
   * @returns 无返回值
   */
  private install(sessionId: string, cell: TraceCell): void {
    if (!this.readers.has(sessionId)) {
      this.readers.set(sessionId, new ReadonlyTraceReader(() => cell.events));
    }
    this.cells.delete(sessionId);
    this.cells.set(sessionId, cell);
    while (this.cells.size > SessionTraceService.MAX_SESSIONS) {
      const oldest = this.cells.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.cells.delete(oldest.value);
      this.readers.delete(oldest.value);
    }
  }

  /**
   * 钳制条数上限。
   * @param raw 请求的条数上限（可缺省 / 非法）
   * @returns 落在 [1, MAX_LIMIT] 的整数（缺省 DEFAULT_LIMIT）
   */
  private static clampLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
      return SessionTraceService.DEFAULT_LIMIT;
    }
    const n = Math.floor(raw);
    return Math.min(SessionTraceService.MAX_LIMIT, Math.max(1, n));
  }

  /**
   * 提取错误消息。
   * @param error 任意抛出值
   * @returns Error 取 message，其余 String() 化
   */
  private static messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
