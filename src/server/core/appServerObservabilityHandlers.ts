/**
 * AppServer 的「只读可观测」处理器（Web 交付项，2026-10-11）：`daemon.status` 与 `doctor.report`。
 *
 * ## 为什么单独成层
 *
 * 沿 `AppServerBase → AppServerHandlers → AppServerSurfaceHandlers → AppServerGovernanceHandlers →
 * **本层** → AppServer` 的分层约定：本层职责是「把本机运行态**如实**告诉面板」，与治理台账、
 * 会话容量都无重合。塞进 `AppServer` 会让那个类越过上帝类阈值（增量门禁 2026-10-11 当场抓到：
 * 733 行 / 25 方法）——分层不是为了好看，是为了不被门禁逼着放宽口径。
 *
 * ## 两条纪律（都在钉"没有就是没有"）
 *
 * 1. `daemon.status` 与 `omniharness daemon status` **同一事实源**：同一个 `DaemonController`、
 *    同一默认 pid 文件（`~/.omniharness/daemon.pid`）⇒ 面板与命令行不会互相打脸；
 * 2. `doctor.report` 未注入实现时**显式报错**（`ok:false` + 原因），绝不返回空报告冒充"体检通过"。
 *
 * @maturity L1 — 两条只读 RPC 与 CLI 同源 / 未接线如实报错 / workspaceRoot 透传 判据钉死
 * @maturityEvidence tests/unit/observabilityRpc.test.ts
 */
import { DaemonController } from '../../daemon/daemonController.ts';
import { AppServerGovernanceHandlers } from './appServerGovernanceHandlers.ts';
import { SessionTraceService } from '../services/session/sessionTraceService.ts';
import type { AuditEvent } from '../services/auditSink.ts';
import { AuditExporter, type AuditQuery } from '../services/auditExporter.ts';
import type {
  TraceReadRequest,
  TraceReadResult,
} from '../../ports/intelligence/traceIntrospection.ts';

/** 只读可观测处理器层。 */
export class AppServerObservabilityHandlers extends AppServerGovernanceHandlers {
  /** 只读 trace 自省服务：把会话事件流投影为冻结条目（`trace.read` RPC 的后端）。 */
  protected readonly trace: SessionTraceService;

  /**
   * @param options 服务端选项（与基座同一份，装配期只读使用）
   */
  public constructor(options: import('./appServerState.ts').AppServerOptions) {
    super(options);
    this.trace = new SessionTraceService({
      events: (sessionId) => this.runtime.agent().eventsOf(sessionId),
      exists: (sessionId) =>
        options.traceSessionExists === undefined
          ? this.sessionTraceExists(sessionId)
          : options.traceSessionExists(sessionId),
      logError: (message) => process.stderr.write(`[omniharness] ${message}\n`),
    });
  }

  /**
   * 注册 `daemon.status` 与 `doctor.report`。
   *
   * @returns 无返回值。
   */
  protected registerObservabilityHandlers(): void {
    this.handlers.set('daemon.status', () => Promise.resolve(new DaemonController().status()));
    this.handlers.set('doctor.report', async (params) => {
      const provided = this.options.doctorReport;
      if (provided === undefined) {
        return { ok: false, reason: 'doctor 未接线（serve 组合根未注入 doctorReport）' };
      }
      const workspaceRoot =
        typeof params['workspaceRoot'] === 'string' ? params['workspaceRoot'] : undefined;
      const report = await provided(workspaceRoot === undefined ? undefined : { workspaceRoot });
      return { ok: true, report };
    });
  }
  /**
   * 解析 trace.read 参数（宽松：非法值按缺省处理，会话 id 原样透传以便如实报错）。
   * @param params RPC 原始参数
   * @returns 规范化后的 trace 查询（session 必填，limit/kind 可缺省）
   */
  protected static traceRequest(params: Record<string, unknown>): TraceReadRequest {
    const rawSession = params['sessionId'];
    const session = typeof rawSession === 'string' ? rawSession : '';
    const kind = typeof params['kind'] === 'string' ? params['kind'] : undefined;
    const limit = typeof params['limit'] === 'number' ? params['limit'] : undefined;
    return {
      session,
      ...(kind !== undefined ? { kind } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  /**
   * 会话事件是否存在于存档（jsonl 目录或 sqlite 库）。
   *
   * 为什么不用 `storage.load()` 判定：它对不存在的会话与零事件会话都返回空数组，
   * 无法区分「没有这个会话」与「这个会话还没有事件」。这里按存储后端的物理形态判定：
   * 文件后端看 `<location>/<id>.jsonl`，sqlite 看库内该会话行；内存后端无可判定处，
   * 回落到事件日志已在内存中的会话集合（`threads` 登记过的线程）。
   * 未知 / 不可判定一律返回 true（宁多报也不误判「会话不存在」）。
   * @param sessionId 会话 id
   * @returns 该会话的事件存档是否存在
   */
  protected async sessionTraceExists(sessionId: string): Promise<boolean> {
    if (sessionId.length === 0) {
      return false;
    }
    // 存档目录 / sqlite 库能枚举会话：以归档列表为唯一判据（file 后端读 .jsonl，sqlite 读库内行）。
    if (this.options.config.storage.location !== undefined) {
      // `'*'`：存在性判定必须看**全量**存档——会话可能属于别的工作区，按当前工作区过滤会让
      // "按 id 打开历史会话"在跨项目时 404（见 SessionArchive.list 的作用域语义）。
      const list = await this.sessionArchive.list(true, '*');
      const sessions = (list as { sessions?: readonly { sessionId: string }[] }).sessions ?? [];
      return sessions.some((entry) => entry.sessionId === sessionId);
    }
    // 内存后端无可枚举的物理存档：以已登记的线程 + 已加载的 trace 缓存为准（宁宽不误报）。
    return this.threads.has(sessionId) || this.trace.has(sessionId);
  }

  /**
   * 只读 trace 自省 RPC（T4.5）：先按会话把事件流加载进只读投影器，再取冻结条目返回。
   *
   * 只读保证：返回条目由 `ReadonlyTraceReader` 深拷贝 + `Object.freeze`，调用方拿到的只是快照；
   * 本 RPC 无任何写方法，agent 无法借道篡改自己的历史。fail-soft：会话不存在或事件源读取失败时
   * 回 `{ entries: [], count: 0, error }`，不抛 RPC 错误打断消费方。
   * @param params `{ sessionId, kind?, limit? }` — 目标会话与可选类别/条数过滤
   * @returns 冻结 trace 条目快照（新在前）+ 计数 + 失败原因
   */
  protected async readTraceRpc(params: Record<string, unknown>): Promise<TraceReadResult> {
    const request = AppServerObservabilityHandlers.traceRequest(params);
    await this.trace.load(request.session);
    return this.trace.read(request);
  }

  /**
   * 审计查询 RPC：读取服务端审计 sink 并应用过滤条件返回事件。
   *
   * 2026-10-11（Web 交付 audit 面板）：返回体改为**判别联合**——未注入 audit 时回
   * `{ok:false, reason}`，而**不是**空数组。理由：面板拿到空数组只能渲染成"审计无记录"，
   * 而真相是"服务端根本没装审计 sink"；这两件事对排查者意义完全不同（与同批 `doctor.report`
   * 的处置同源）。
   * @param params `{ since?, until?, type?, session?, actor?, limit? }`
   * @returns `{ok:true, events}` 或 `{ok:false, reason}`。
   */
  protected queryAuditRpc(
    params: Record<string, unknown>,
  ):
    | { readonly ok: true; readonly events: AuditEvent[] }
    | { readonly ok: false; readonly reason: string } {
    const sink = this.options.audit;
    if (sink === undefined) {
      return { ok: false, reason: 'audit 未接线（serve 组合根未注入 audit sink）' };
    }
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;
    const num = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
      return undefined;
    };
    const query: AuditQuery = {
      since: str(params['since']),
      until: str(params['until']),
      type: str(params['type']),
      session: str(params['session']),
      actor: str(params['actor']),
      limit: num(params['limit']),
    };
    return { ok: true, events: AuditExporter.queryAudit(sink.read(), query) };
  }
}
