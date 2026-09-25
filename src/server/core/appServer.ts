import type {
  LongTermMemoryPort,
  MemoryFact,
  MemoryFactPatch,
} from '../../ports/memory/longTermMemory.js';
import { WorkflowRunner } from '../../autonomy/workflowRunner.js';
import type { WorkflowDef } from '../../autonomy/workflowTypes.js';
import { jsonRpc } from './jsonRpc.js';
import type { ImageContent, FileAttachment } from '../../ports/model/model.js';
import { Id } from '../../util/id.js';
import { AuditExporter, type AuditQuery } from '../services/auditExporter.js';
import type { AuditEvent } from '../services/auditSink.js';
import { AppServerSurfaceHandlers } from './appServerSurfaceHandlers.js';
import type { AppServerOptions, GraphRunState } from './appServerState.js';
import { providerPresets } from '../services/providerPresets.js';
import { RepoPathGuard } from '../services/repoPathGuard.js';
import { DiffReview } from '../services/diffReview.js';
import { DiffCommentStore } from '../services/diffCommentStore.js';
import { SessionCheckpoints } from '../services/sessionCheckpoints.js';
import { SessionTraceService } from '../services/sessionTraceService.js';
import { SessionRewindService } from '../services/sessionRewindService.js';
import type { SessionRewindOutcome } from '../services/sessionRewindService.js';
import type {
  TraceReadRequest,
  TraceReadResult,
} from '../../ports/intelligence/traceIntrospection.js';

export type { AppServerOptions } from './appServerState.js';

/**
 * app-server：JSON-RPC 原语（threads/turns/items）+ 事件推送 + 审批上行。
 *
 * 叶类，薄门面：只保留「方法调度 + 线程/回合/图/记忆处理器」，把可复用的领域逻辑
 * 组合为独立服务——`DiffReview`（git 审查）、`DiffCommentStore`（评论持久化）、
 * `SessionCheckpoints`（会话检查点）、`RepoPathGuard`（路径安全）。服务在构造期装配一次，
 * 每个 RPC 调用零额外构造开销。
 */
export class AppServer extends AppServerSurfaceHandlers {
  /** git 差异审查服务：hunk/file 级 stage/revert（changes.* RPC 的后端）。 */
  private readonly diffReview: DiffReview;
  /** 差异行级评论存储：评论的增删查持久化。 */
  private readonly diffComments: DiffCommentStore;
  /** 会话检查点服务：检查点创建、列表与回滚。 */
  private readonly checkpoints: SessionCheckpoints;
  /** 只读 trace 自省服务：把会话事件流投影为冻结条目（`trace.read` RPC 的后端）。 */
  private readonly trace: SessionTraceService;
  /** 会话回退服务：把持久化事件流截断到指定事件（`threads.rewind` RPC 的后端）。 */
  private readonly rewinder: SessionRewindService;

  /**
   * 装配各领域服务并注册全部 RPC 处理器与传输层监听。
   * @param options app-server 选项（transport、config、workspaceRoot、audit 等）
   */
  public constructor(options: AppServerOptions) {
    super(options);
    // 工作区根以 getter 注入：支持运行时 workspace.switch 后服务仍取到最新根。
    const workspaceRoot = (): string => this.effectiveWorkspace();
    const guard = new RepoPathGuard(workspaceRoot);
    this.diffReview = new DiffReview({ workspaceRoot, guard });
    this.diffComments = new DiffCommentStore({ workspaceRoot, guard });
    this.checkpoints = new SessionCheckpoints({
      storage: options.config.storage,
      workspaceRoot: options.workspaceRoot,
    });
    // T4.5 接线：只读 trace 自省的事件源取运行时 agent 的 replay（同一事实源，纯读不写）；
    // 存在性判定另走事件日志存档（storage.load 对不存在的会话也回空数组，不足以区分「无此会话」）。
    this.trace = new SessionTraceService({
      replay: (sessionId) => this.runtime.agent().replay(sessionId),
      exists: (sessionId) =>
        options.traceSessionExists === undefined
          ? this.sessionTraceExists(sessionId)
          : options.traceSessionExists(sessionId),
      logError: (message) => process.stderr.write(`[omniharness] ${message}\n`),
    });
    this.registerHandlers();
    // 会话回退（`threads.rewind`）：读 / 写都指向**唯一事实源**（storage），
    // 运行态判定复用 runTurn 维护的 activeTurns（运行中拒绝回退，避免两处写盘互相覆盖）。
    this.rewinder = new SessionRewindService({
      replay: (sessionId) => this.runtime.agent().replay(sessionId),
      save: (sessionId, events) => this.options.config.storage.save(sessionId, events),
      isRunning: (sessionId) => this.activeTurns.has(sessionId),
    });
    options.transport.onMessage((message) => void this.handle(message));
    // 启动时异步探测一次当前 active 厂商（fire-and-forget，不阻塞 listen）。
    // 解决「页面刷新时模型下拉只有当前选中那一个」#OBS-4：探测拿到真实 /v1/models 后
    // 注入 probeCache，UI 重新拉 model.catalog 就能列出厂商全部模型。
    void this.warmActiveProvider();
  }

  /**
   * 暖当前 active 厂商的 /v1/models 缓存。失败静默（probeCache 不被覆盖，UI 用兜底清单）。
   * @returns 探测完成后 resolve，无载荷（结果写入 modelCatalog 的 probeCache）
   */
  private async warmActiveProvider(): Promise<void> {
    try {
      // 只探测当前 active 厂商（按 baseUrl 严格匹配 → 否则按 modelAdapter 匹配第一个有 key 的预设），
      // 不全表扫 7 个厂商，避免启动慢、流量浪费。
      const file = this.configStore.fileConfig();
      const keys = file.providerKeys ?? {};
      const topKey = typeof file.apiKey === 'string' ? file.apiKey : undefined;
      // 生效目录含用户 `providerPresets` 覆盖：自建厂商配了 Key 也应被暖一遍。
      const presets = providerPresets.resolve(file.providerPresets);
      const matched =
        presets.find((p) => typeof file.baseUrl === 'string' && file.baseUrl === p.baseUrl) ??
        // 注意：必须要求该厂商在 providerKeys 或顶层 apiKey 中有 key，否则探测无意义（无凭据）。
        presets.find(
          (p) =>
            p.adapter === file.modelAdapter && (topKey !== undefined || keys[p.id] !== undefined),
        );
      const target = matched?.id;
      // 没匹配到厂商（纯 mock 或无凭据）就什么都不做，避免无意义探测。
      if (target === undefined) return;
      await this.modelCatalog.probe({ provider: target });
    } catch {
      // 静默失败：探测走 HTTP，UI 后台再点「检测」按钮也能补。
    }
  }

  /**
   * 注册方法处理。
   * @returns 无返回值。
   */
  protected registerHandlers(): void {
    this.handlers.set('threads.create', (params) => this.createThread(params));
    this.handlers.set('threads.continue', (params) => this.continueThread(params));
    this.handlers.set('threads.fork', (params) => this.forkThread(params));
    this.handlers.set('threads.get', (params) => this.getThread(params));
    this.handlers.set('threads.rewind', (params) => this.rewindThread(params));
    this.handlers.set('turns.run', (params) => this.runTurn(params));
    this.handlers.set('turns.abort', async (params) => {
      // 中断在跑回合：取消令牌贯穿模型请求 fetch（见 agent.cancelCurrentRun），
      // 在飞请求被中止后 turns.run 自然收尾，SSE 已推送的增量事件不受影响。
      //
      // 2026-09-22 修（审计 P1）：此前不带 threadId、一律取消「当前」会话，而服务端允许多回合并行
      // ⇒ 先结束者清空令牌会让「停止」静默失效，或把**别的会话**取消掉。现按会话定向取消：
      // 传了 threadId 只停该会话；旧前端不带参数时退化为「取消全部在跑回合」（不静默失效）。
      const threadId = String(params['threadId'] ?? params['sessionId'] ?? '');
      this.runtime.agent().cancelCurrentRun('user', threadId === '' ? undefined : threadId);
      return { ok: true, threadId: threadId === '' ? null : threadId };
    });
    this.handlers.set('approval.respond', (params) => this.respondApproval(params));
    this.handlers.set('config.get', () => Promise.resolve(this.configStore.get()));
    this.handlers.set('config.update', (params) => Promise.resolve(this.updateConfig(params)));
    this.handlers.set('model.catalog', () => Promise.resolve(this.modelCatalog.catalog()));
    this.handlers.set('model.probe', (params) => this.modelCatalog.probe(params));
    this.handlers.set('usage.stats', () => Promise.resolve(this.sessionArchive.usage()));
    this.handlers.set('workspace.list', () => Promise.resolve(this.configStore.workspaces()));
    this.handlers.set('workspace.add', (params) =>
      Promise.resolve(this.configStore.addWorkspace(params['path'])),
    );
    this.handlers.set('workspace.switch', (params) =>
      Promise.resolve(this.switchWorkspace(params['path'])),
    );
    this.handlers.set('audit.query', (params) => Promise.resolve(this.queryAuditRpc(params)));
    // T4.5：只读 trace 自省 RPC（agent 自查「我刚做了什么」，无写方法，不可借道改历史）。
    this.handlers.set('trace.read', (params) => this.readTraceRpc(params));
    this.registerCheckpointHandlers();
    this.registerReviewHandlers();
    this.handlers.set('fs.list', (params) => Promise.resolve(this.workspaceTree.list(params)));
    this.handlers.set('fs.read', (params) => Promise.resolve(this.workspaceTree.readFile(params)));
    this.handlers.set('sessions.list', async () => {
      const r = (await this.sessionArchive.list()) as {
        dir: string;
        sessions: { sessionId: string; running?: boolean }[];
      };
      // 真实运行态：runTurn 进入/退出维护 activeTurns，前端不再靠 mtime 猜测。
      return {
        dir: r.dir,
        sessions: r.sessions.map((s) => ({ ...s, running: this.activeTurns.has(s.sessionId) })),
      };
    });
    this.handlers.set('sessions.rename', async (params) =>
      this.sessionArchive.rename(String(params['sessionId'] ?? ''), String(params['title'] ?? '')),
    );
    this.handlers.set('sessions.delete', async (params) => {
      const id = String(params['sessionId'] ?? '');
      if (this.activeTurns.has(id)) return { ok: false, error: 'session_running' };
      return this.sessionArchive.delete(id);
    });
    this.handlers.set('sessions.fork', async (params) =>
      this.sessionArchive.fork(String(params['sessionId'] ?? '')),
    );
    this.handlers.set('changes.list', (params) =>
      Promise.resolve(this.workspaceChanges.list(params)),
    );
    this.handlers.set('fs.browse', (params) => Promise.resolve(this.fsExplorer.browse(params)));
    this.handlers.set('fs.mkdir', (params) => Promise.resolve(this.fsExplorer.mkdir(params)));
    this.handlers.set('attach.read', (params) =>
      Promise.resolve(this.fsExplorer.readAttachments(params)),
    );
    this.registerPluginHandlers();
    this.registerGraphHandlers();
    this.registerMemoryHandlers();
    this.registerProfileHandlers();
    this.registerBundleHandlers();
    this.registerSurfaceHandlers();
  }

  /**
   * 多 Agent 编排 RPC（G-C，对标 codex agent-graph-store）：图增删查 + 运行 + 实时状态。
   * @returns 无返回值。
   */
  protected registerGraphHandlers(): void {
    this.handlers.set('graph.list', async () => this.runtime.graphStore().list());
    this.handlers.set('graph.get', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('graph.get 需要 id');
      }
      const def = this.runtime.graphStore().get(idParam);
      if (def === undefined) {
        throw new Error('未找到图: ' + idParam);
      }
      return def;
    });
    this.handlers.set('graph.save', async (params) => {
      const def = params['def'];
      if (
        def === undefined ||
        typeof def !== 'object' ||
        !Array.isArray((def as Partial<WorkflowDef>).steps)
      ) {
        throw new Error('graph.save 需要 def（含 name 与 steps）');
      }
      const savedId = this.runtime.graphStore().save(def as WorkflowDef);
      return { ok: true, id: savedId };
    });
    this.handlers.set('graph.delete', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('graph.delete 需要 id');
      }
      return { ok: this.runtime.graphStore().delete(idParam) };
    });
    this.handlers.set('graph.run', async (params) => this.runGraph(params));
    this.handlers.set('graph.status', async (params) => {
      const runId = params['runId'];
      if (typeof runId !== 'string') {
        throw new Error('graph.status 需要 runId');
      }
      const run = this.graphRuns.get(runId);
      if (run === undefined) {
        throw new Error('未找到运行: ' + runId);
      }
      return {
        runId: run.runId,
        defId: run.defId,
        defName: run.defName,
        done: run.done,
        ok: run.ok,
        nodes: Object.values(run.nodes),
        blackboard: run.blackboard,
      };
    });
  }

  /**
   * 会话检查点 / 回滚 RPC（对标 Codex「回滚到检查点」）：列表 / 创建 / 回滚（对话 + 代码）。
   * @returns 无返回值。
   */
  private registerCheckpointHandlers(): void {
    this.handlers.set('checkpoint.list', (params) => this.checkpoints.list(params));
    this.handlers.set('checkpoint.create', (params) => this.checkpoints.create(params));
    this.handlers.set('checkpoint.rollback', (params) => this.checkpoints.rollback(params));
  }

  /**
   * 内联 diff 审查 RPC（对标 Codex Review）：hunk/file 级 stage/revert + 行级评论。
   * @returns 无返回值。
   */
  private registerReviewHandlers(): void {
    this.handlers.set('changes.stageFile', (params) =>
      Promise.resolve(this.diffReview.stageFile(params)),
    );
    this.handlers.set('changes.revertFile', (params) =>
      Promise.resolve(this.diffReview.revertFile(params)),
    );
    this.handlers.set('changes.stageHunk', (params) =>
      Promise.resolve(this.diffReview.stageHunk(params)),
    );
    this.handlers.set('changes.revertHunk', (params) =>
      Promise.resolve(this.diffReview.revertHunk(params)),
    );
    this.handlers.set('changes.comments.list', () => Promise.resolve(this.diffComments.list()));
    this.handlers.set('changes.comments.add', (params) =>
      Promise.resolve(this.diffComments.add(params)),
    );
    this.handlers.set('changes.comments.delete', (params) =>
      Promise.resolve(this.diffComments.remove(params)),
    );
  }

  /**
   * 长期记忆管理 RPC（#G-D / 4.3，对标 codex dedicated memories）：列表/查看/增/改/删/检索 + 变更实时通知。
   * @returns 无返回值。
   */
  protected registerMemoryHandlers(): void {
    const store = (): LongTermMemoryPort => this.options.config.longTermMemory;
    this.handlers.set('memory.list', async () => {
      const facts = store().all();
      return { count: facts.length, facts: facts.map((f) => ({ ...f })) };
    });
    this.handlers.set('memory.get', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('memory.get 需要 id');
      }
      const fact = store().get(idParam);
      if (fact === undefined) {
        throw new Error('未找到记忆: ' + idParam);
      }
      return { ...fact };
    });
    this.handlers.set('memory.add', async (params) => {
      const text = params['text'];
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('memory.add 需要非空 text');
      }
      const topic = typeof params['topic'] === 'string' ? (params['topic'] as string) : undefined;
      const rawImp = typeof params['importance'] === 'number' ? params['importance'] : 3;
      const importance = Math.min(5, Math.max(1, Math.round(rawImp)));
      const fact: MemoryFact = {
        id: Id.id('mem'),
        text: text.trim(),
        topic,
        importance,
        createdAt: new Date().toISOString(),
        sessionId: 'ui-manual',
        source: 'tool',
      };
      store().remember(fact);
      this.options.transport.send(jsonRpc.notify('memory.changed', {}));
      return { ok: true, id: fact.id };
    });
    this.handlers.set('memory.update', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('memory.update 需要 id');
      }
      const patch: MemoryFactPatch = {};
      if (typeof params['text'] === 'string') patch.text = params['text'];
      if (typeof params['topic'] === 'string') patch.topic = params['topic'];
      if (typeof params['importance'] === 'number') patch.importance = params['importance'];
      const ok = store().update(idParam, patch);
      if (!ok) {
        throw new Error('未找到记忆: ' + idParam);
      }
      this.options.transport.send(jsonRpc.notify('memory.changed', {}));
      return { ok: true };
    });
    this.handlers.set('memory.delete', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('memory.delete 需要 id');
      }
      const ok = store().delete(idParam);
      if (!ok) {
        throw new Error('未找到记忆: ' + idParam);
      }
      this.options.transport.send(jsonRpc.notify('memory.changed', {}));
      return { ok: true };
    });
    this.handlers.set('memory.search', async (params) => {
      const query = params['query'];
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('memory.search 需要非空 query');
      }
      const limit =
        typeof params['limit'] === 'number'
          ? Math.max(1, Math.floor(params['limit'] as number))
          : 5;
      const hits = store().recall(query, limit);
      return {
        count: hits.length,
        results: hits.map((fact) => ({
          id: fact.id,
          topic: fact.topic,
          text: fact.text,
          importance: fact.importance,
        })),
      };
    });
  }

  /**
   * 创建线程（threads.create）：以 prompt 启动一次全新 agent 任务并登记线程映射。
   * @param params `{ prompt }` — 首条用户消息，缺省为空串
   * @returns 线程结果（sessionId、本次回合事件等，见 threadResult）
   */
  protected async createThread(params: Record<string, unknown>): Promise<unknown> {
    const result = await this.runtime.agent().runTask(String(params['prompt'] ?? ''));
    this.threads.set(result.sessionId, result.sessionId);
    return this.threadResult(result);
  }

  /**
   * 续跑线程（threads.continue）：在既有 threadId 上追加一条用户消息并继续对话。
   * @param params `{ threadId, prompt }` — 目标线程与追加消息
   * @returns 线程结果（sessionId 与本次回合事件）
   */
  protected async continueThread(params: Record<string, unknown>): Promise<unknown> {
    const result = await this.runtime
      .agent()
      .resume(String(params['threadId'] ?? ''), String(params['prompt'] ?? ''));
    this.threads.set(result.sessionId, result.sessionId);
    return this.threadResult(result);
  }

  /**
   * 分叉线程（threads.fork）：复制既有 threadId 的历史后以 prompt 开启新分支。
   * @param params `{ threadId, prompt }` — 被分叉线程与新分支首条消息
   * @returns 线程结果（新分支 sessionId 与事件）
   */
  protected async forkThread(params: Record<string, unknown>): Promise<unknown> {
    const result = await this.runtime
      .agent()
      .fork(String(params['threadId'] ?? ''), String(params['prompt'] ?? ''));
    this.threads.set(result.sessionId, result.sessionId);
    return this.threadResult(result);
  }

  /**
   * 获取线程事件（threads.get）：重放指定线程的全部历史事件。
   * @param params `{ threadId }` — 目标线程
   * @returns `{ threadId, items }` — 线程标识与事件数组
   */
  protected async getThread(params: Record<string, unknown>): Promise<unknown> {
    const threadId = String(params['threadId'] ?? '');
    const items = await this.runtime.agent().replay(threadId);
    return { threadId, items };
  }

  /**
   * 服务端回退线程（threads.rewind）：把持久化事件流截断到指定事件（含），使前端的
   * 「重生成」是**真回退**而不是「接着旧答案再来一轮」。
   *
   * 只做截断，不重跑（重跑仍走 `turns.run`，与既有提交通路一致）；失败一律如实回 `error`
   * 而不抛错给 RPC 层，便于前端直接把原因显示出来。
   *
   * @param params `{ threadId, keepEventId }` — 目标线程与保留到哪条事件（含）
   * @returns 保留/丢弃条数，或失败原因（见 {@link SessionRewindOutcome}）
   */
  protected async rewindThread(params: Record<string, unknown>): Promise<SessionRewindOutcome> {
    const threadId = String(params['threadId'] ?? params['sessionId'] ?? '');
    return this.rewinder.rewind(threadId, String(params['keepEventId'] ?? ''));
  }

  /**
   * 运行回合（turns.run）：线程已存在则续跑，否则等价创建新线程。
   * images 可选，随首条用户消息送入模型（#B1）。
   * @param params `{ threadId, prompt, images?, files? }` — 目标线程、消息文本与可选附件
   * @returns 线程结果（sessionId、事件与用量）
   */
  protected async runTurn(params: Record<string, unknown>): Promise<unknown> {
    const threadId = String(params['threadId'] ?? '');
    const prompt = String(params['prompt'] ?? '');
    const images = params['images'] as readonly ImageContent[] | undefined;
    const files = params['files'] as readonly FileAttachment[] | undefined;
    // 会话模式（UI「+」菜单的目标 / 计划 / 绘图）在此合成前置指令：
    // 只改本回合的用户消息文本，不动系统提示词（系统提示词被缓存，改它会整体失效）。
    // 无模式时 compose 原样返回 prompt，行为与旧版逐字节一致。
    const effective = this.directives.compose(prompt, this.modes.get(threadId));
    // 真实运行态跟踪：并行任务卡据此显示「运行中」，而非前端猜测。
    this.activeTurns.add(threadId);
    try {
      const result = this.threads.has(threadId)
        ? await this.runtime.agent().resume(threadId, effective, images, files)
        : await this.runtime.agent().runTask(effective, images, files);
      this.threads.set(result.sessionId, result.sessionId);
      return this.threadResult(result);
    } finally {
      this.activeTurns.delete(threadId);
    }
  }

  /**
   * 响应审批上行（approval.respond）：委托事件桥把决定送达等待中的审批方。
   * @param params `{ requestId, decision }` — 审批请求标识与批准/拒绝决定
   * @returns 事件桥处理结果（是否成功送达）
   */
  protected async respondApproval(params: Record<string, unknown>): Promise<unknown> {
    return this.events.respondApproval(params);
  }

  /**
   * 审计查询 RPC：读取服务端审计 sink 并应用过滤条件返回事件数组。
   * @param params `{ since?, until?, type?, session?, actor?, limit? }`
   * @returns 过滤后的事件数组（未注入 audit 时为空）
   */
  protected queryAuditRpc(params: Record<string, unknown>): AuditEvent[] {
    const sink = this.options.audit;
    if (sink === undefined) return [];
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
    return AuditExporter.queryAudit(sink.read(), query);
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
    const request = AppServer.traceRequest(params);
    await this.trace.load(request.session);
    return this.trace.read(request);
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
  private async sessionTraceExists(sessionId: string): Promise<boolean> {
    if (sessionId.length === 0) {
      return false;
    }
    // 存档目录 / sqlite 库能枚举会话：以归档列表为唯一判据（file 后端读 .jsonl，sqlite 读库内行）。
    if (this.options.config.storage.location !== undefined) {
      const list = await this.sessionArchive.list();
      const sessions = (list as { sessions?: readonly { sessionId: string }[] }).sessions ?? [];
      return sessions.some((entry) => entry.sessionId === sessionId);
    }
    // 内存后端无可枚举的物理存档：以已登记的线程 + 已加载的 trace 缓存为准（宁宽不误报）。
    return this.threads.has(sessionId) || this.trace.has(sessionId);
  }

  /**
   * 解析 trace.read 参数（宽松：非法值按缺省处理，会话 id 原样透传以便如实报错）。
   * @param params RPC 原始参数
   * @returns 规范化后的 trace 查询（session 必填，limit/kind 可缺省）
   */
  private static traceRequest(params: Record<string, unknown>): TraceReadRequest {
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
   * 异步运行图（DAG 编排）：立即返回 runId，节点状态经 graph.progress 通知实时推送，
   * 结束经 graph.done 通知。运行态存于 graphRuns 供 graph.status 查询。
   * @param params `{ id?, def? }` — 已存图 id 或内联图定义（含 name 与 steps），二者必居其一
   * @returns `{ runId, nodeCount }` — 本次运行标识与节点总数
   */
  protected runGraph(params: Record<string, unknown>): { runId: string; nodeCount: number } {
    const store = this.runtime.graphStore();
    let def: WorkflowDef | undefined;
    const idParam = typeof params['id'] === 'string' ? params['id'] : undefined;
    const defArg = params['def'];
    if (idParam !== undefined) {
      def = store.get(idParam);
      if (def === undefined) {
        throw new Error('未找到图: ' + idParam);
      }
    } else if (
      defArg !== undefined &&
      typeof defArg === 'object' &&
      Array.isArray((defArg as Partial<WorkflowDef>).steps)
    ) {
      def = defArg as WorkflowDef;
    } else {
      throw new Error('graph.run 需要 id（已存图）或 def（内联定义）');
    }

    const runId = Id.id('run');
    const runState: GraphRunState = {
      runId,
      defId: idParam,
      defName: def.name,
      nodes: {},
      done: false,
      startedAt: Date.now(),
    };
    for (const step of def.steps) {
      runState.nodes[step.id] = { id: step.id, status: 'pending' };
    }
    this.graphRuns.set(runId, runState);

    const ports = this.runtime.graphPorts();
    void new WorkflowRunner(ports, {
      maxConcurrency: def.maxConcurrency,
      onNodeUpdate: (update) => {
        const node = runState.nodes[update.id];
        if (node !== undefined) {
          node.status = update.status;
          node.error = update.error;
          node.steps = update.steps;
          node.durationMs = update.durationMs;
        }
        this.options.transport.send(jsonRpc.notify('graph.progress', { runId, ...update }));
      },
    })
      .run(def)
      .then((result) => {
        runState.done = true;
        runState.ok = result.ok;
        runState.blackboard = result.blackboard;
        this.options.transport.send(
          jsonRpc.notify('graph.done', {
            runId,
            ok: result.ok,
            blackboard: { ...result.blackboard },
          }),
        );
      })
      .catch((error: unknown) => {
        runState.done = true;
        runState.ok = false;
        this.options.transport.send(
          jsonRpc.notify('graph.done', { runId, ok: false, error: this.messageOf(error) }),
        );
      });

    return { runId, nodeCount: def.steps.length };
  }
}
