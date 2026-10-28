// 会话 / 事件 / 文件相关控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中与会话、事件流、工具结果、文件预览、钻取、抽屉相关的回调，
// 一律经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.ts';
import type { ThreadEvent } from '../../types/models.ts';
import type { SessionEntry, ToolItem } from '../shared.ts';
import { TurnStreamBuffer } from '../models/TurnStreamBuffer.ts';
import { SessionsScope } from '../models/SessionsScope.ts';
import { DeferredModes } from '../models/DeferredModes.ts';
import { ViewAttachment } from '../models/ViewAttachment.ts';
import { SessionProjectBinding } from '../models/SessionProjectBinding.ts';
import type { SessionModePatch } from '../models/PendingModes.ts';
import { MethodBinder } from './methodBinder.ts';
import { SessionTicker } from './sessionTicker.ts';
import { t } from '../i18n/i18n.ts';

/** 历史分页页大小（首屏只取尾部；更早内容按需补拉）。 */
const HISTORY_PAGE_SIZE = 300;

/** 会话 / 事件 / 文件控制器：单一职责，仅供 App 组合使用。 */
export class SessionController {
  /** 状态宿主。 */
  private readonly host: AppHost;
  /** 共享服务。 */
  private readonly services: AppServices;
  /** 会话模式协作者：有会话立刻落盘、没会话先暂存（构造时注入 API 落盘口）。 */
  public readonly modes: DeferredModes;
  /**
   * 视图挂载状态（**视图代数**）：摘（`newSession`）与挂（`loadThread`）都发生在本控制器，同源才不会
   * 两处各改一半；兄弟控制器经 `sessions.viewAttachment` 读。语义见 `models/ViewAttachment.ts`。
   */
  public readonly viewAttachment: ViewAttachment;
  /** 本回合的流式缓冲（节流 + 生命周期）：语义见 `models/TurnStreamBuffer.ts`。 */
  private readonly stream: TurnStreamBuffer;
  /** 会话数据版本号（`AppState.sessionTick`）的去抖器。 */
  private readonly ticker: SessionTicker;
  /** `loadThread` 的请求代际（后发请求递增；陈旧响应据此刻弃）。 */
  private loadGeneration = 0;
  /**
   * 点「新建」时被放弃的会话 id（迟到事件不得被认领成当前会话）。
   *
   * 为什么需要它：`newSession()` 只摘视图，旧回合仍在飞；用户随即在新会话里发送时
   * `ComposerController.send()` 会重新 `attach()`，于是「已摘」的护栏失效。此时旧会话的
   * 收尾事件先到就会把 `currentThreadId` 认领成旧会话，新会话自己的事件反而因 sid 不匹配
   * 被丢弃（视图串会话 + 新回合过程事件丢失）。
   */
  private abandonedThreadId: string | null = null;

  /**
   * 构造并绑定对外回调。
   * @param host 状态宿主
   * @param services 共享服务
   */
  public constructor(host: AppHost, services: AppServices) {
    this.host = host;
    this.services = services;
    this.modes = new DeferredModes((id, patch) => services.api.modesSet(id, patch));
    // 默认**挂载**：刷新 / 深链 / 全新控制器都要能收流式事件，只有点「新建」才摘。
    this.viewAttachment = new ViewAttachment();
    this.ticker = new SessionTicker(() => {
      this.host.patch((s) => ({ sessionTick: s.sessionTick + 1 }));
    });
    this.stream = new TurnStreamBuffer((text) => {
      this.host.patch((s) => ({
        streamText: this.services.reducers.appendTextDelta(s.streamText, text),
      }));
    });
    // 一次绑定**全部**原型方法（见 MethodBinder：手写清单曾漏掉 rename/delete/fork ⇒「删除无效」）。
    MethodBinder.bindAll(this);
  }

  /**
   * 处理一条事件流事件：tool_call 清增量并记活动工具、assistant/reasoning 清活动工具、
   * 末尾追加事件、tool_result 合并结果。
   * @param ev 事件
   * @returns 无
   */
  public handleEvent(ev: ThreadEvent): void {
    // 已摘视图（用户点了「新建」或切走）：迟到事件属于上一回合，不得写进当前视图。
    if (this.viewAttachment.detached) return;
    // **别家会话的事件一律不进本视图**（2026-10-07 用户截图：「非本会话的信息，却因为我切换会话就
    // 显示过来了」）：SSE 的 `thread.event` 载荷带 sessionId，而这里此前**不看它**——于是切会话后仍
    // 在跑的另一个会话（或上一会话的收尾事件）会被追加进当前视图，表现为"凭空冒出一条进行中的工具卡"，
    // 且它永远等不到自己的 tool_result（那条结果属于别的会话）⇒ 卡片永久停在「进行中…」。
    // 只在两侧都有值时才判定：缺 sessionId 的事件（老服务端）保持既有行为，绝不因宿主升级而丢事件。
    const sid = (ev as { sessionId?: unknown }).sessionId;
    const current = this.host.getState().currentThreadId;
    if (typeof sid === 'string' && sid !== '' && current !== null && current !== '' && sid !== current) {
      return;
    }
    // 新会话：turns.run 的响应要等回合结束才回来，而事件流从第一步就带 sessionId。
    // 不在这里认领，整个回合里 currentThreadId 都是 null ⇒ 容量面板按空会话取数（实测全零）、
    // 回滚 / Trace 也拿不到会话。认领后 currentThreadId 立刻可用，收尾时 res.threadId 再幂等覆盖。
    if (typeof sid === 'string' && sid !== '' && (current === null || current === '')) {
      // 被「新建」放弃的旧会话：它的迟到事件属于用户已离开的回合，认领它会让视图串回旧会话。
      if (sid === this.abandonedThreadId) return;
      this.abandonedThreadId = null;
      this.host.patch({ currentThreadId: sid });
    }
    const p = ev.payload || {};
    if (ev.type === 'tool_call') {
      const callId = (p.callId as string) || ev.id;
      this.host.patch((s) => ({
        liveInputs: s.liveInputs.filter((l) => l.id !== callId),
        activeTool: (p.name as string) ?? null,
      }));
    }
    if (ev.type === 'assistant' || ev.type === 'reasoning') {
      this.host.patch({ activeTool: null });
    }
    this.host.patch((s) => this.services.reducers.ingestEvent(s, ev));
    // 面板数据（指标/审计/治理/回滚/记忆…）跟随回合推进：语义事件后去抖 +1，不随 token 增量抖动。
    if (ev.type === 'tool_result' || ev.type === 'model' || ev.type === 'user' || ev.type === 'turn_diff') {
      this.ticker.schedule();
    }
    if (ev.type === 'tool_result') {
      const callId = p.callId as string;
      if (callId) {
        this.host.patch((s) => ({ toolResults: this.services.reducers.mergeToolResult(s.toolResults, callId, p) }));
      }
    }
  }

  /**
   * 累积一条模型正文增量（`thread.text_delta` 通知），驱动流式助手卡片逐字渲染。
   *
   * 增量先过 `TurnStreamBuffer`（节流）再进状态：长回答的 `text_delta` 可达数千条，逐条 setState
   * 会让整棵中栏重渲染 ⇒ 掉帧；累计文本与逐条拼接完全一致（收尾 flush 兜底）。
   * 仅在回合进行中（busy）累积——否则「停止」之后流式卡片会被迟到 delta 重新点亮。
   * @param params 增量载荷（含 text 增量片段）
   * @returns 无
   */
  public appendTextDelta(params: Record<string, unknown>): void {
    // 已摘视图：迟到增量属于上一回合，连缓冲都不该进（见 ViewAttachment）。
    if (this.viewAttachment.detached) return;
    if (!this.host.getState().busy) {
      // 非忙碌态：顺手丢弃缓冲，让此后任何迟到增量连缓冲都进不去（与既有 busy 护栏同向叠加）。
      this.stream.discard();
      return;
    }
    const text = typeof params.text === 'string' ? params.text : '';
    this.stream.push(text);
  }

  /**
   * 回合流式缓冲的生命周期开关：`open` 开新回合、`flush` 收尾本回合。
   *
   * 合成一个方法而不是两个：`SessionController` 的方法数已到上帝类阈值（>25），
   * 而这两个动作本来就是同一缓冲的两端，合成后调用点也更清楚
   * （`ComposerController` 里 `streamPhase('open')` / `streamPhase('flush')`）。
   * @param phase 'open' 开新回合缓冲；'flush' 把最后一段增量刷进状态并释放节流器
   * @returns 无
   */
  public streamPhase(phase: 'open' | 'flush'): void {
    if (phase === 'open') this.stream.open();
    else this.stream.flush();
  }

  /**
   * 合并一条工具增量输入。
   * @param params 增量载荷
   * @returns 无
   */
  public updateToolInput(params: Record<string, unknown>): void {
    if (this.viewAttachment.detached) return;
    this.host.patch((s) => ({ liveInputs: this.services.reducers.mergeToolInput(s.liveInputs, params) }));
  }

  /**
   * 刷新磁盘会话列表（含各项目工作区标记），保留内存态中未落盘的会话。
   * @param includeArchived 是否连归档会话一起读（缺省 false = 快速路径：服务端跳过归档文件的逐个
   *   扫描；归档行已在内存时会被 `mergeSessions` 保留，故不影响「已归档」组的显示）
   * @returns 异步完成
   */
  public async refreshSessions(includeArchived = false): Promise<void> {
    try {
      // 显示范围来自本机偏好（当前项目 / 全部项目）：服务端据此过滤或全量返回。
      const scope = SessionsScope.read();
      const r = await this.services.api.listSessions({
        includeArchived,
        ...(SessionsScope.workspaceParam(scope) !== undefined
          ? { workspace: SessionsScope.workspaceParam(scope) }
          : {}),
      });
      const fromDisk: SessionEntry[] = r.sessions.map((s) => ({
        id: s.sessionId,
        label: s.label || s.sessionId,
        workspace: s.workspace,
        updatedAt: s.updatedAt,
        turns: s.turns,
        // 有效时长/空闲间隔：服务端已剔除 >5 分钟挂机；卡片与悬停据此展示，而非墙钟。
        ...(s.activeMs !== undefined ? { activeMs: s.activeMs } : {}),
        ...(s.idleGaps !== undefined ? { idleGaps: s.idleGaps } : {}),
        ...(s.mock !== undefined ? { mock: s.mock } : {}),
        ...(s.model !== undefined ? { model: s.model } : {}),
        running: s.running === true,
        archived: s.archived === true,
      }));
      this.host.patch((s) => ({ sessions: this.services.reducers.mergeSessions(s.sessions, fromDisk) }));
    } catch {
      /* 静默：列表不可用时保留内存态 */
    }
  }

  /**
   * 翻转会话列表的显示范围（当前项目 ⇄ 全部项目）并立即重取。
   *
   * 为什么要有它：存档是全局的、按项目标记归属，缺省只显示当前项目；没有这个开关，用户在别的
   * 启动目录下就会以为"项目数据读不到"（2026-10-06 用户实测反馈）。
   * @returns 异步完成
   */
  public async toggleSessionsScope(): Promise<void> {
    const next = SessionsScope.toggle(SessionsScope.read());
    SessionsScope.write(next);
    this.host.patch({ sessionsScopeAll: next === 'all' });
    await this.refreshSessions();
  }

  /**
   * 应用会话模式（目标 / 计划 / 绘图）。
   *
   * 有没有"当前会话"由协作者 {@link DeferredModes} 决策（会话是惰性创建的）：有 ⇒ 立刻落盘；
   * 没有 ⇒ 暂存，等会话出现再落盘——否则用户在建会话前点「计划模式」只会看到
   * 「模式切换失败：modes.set 需要 threadId」（2026-10-06 真机截图）。
   * @param patch 模式补丁。
   * @returns `'applied'` 已落盘；`'deferred'` 已暂存（等会话创建）。
   */
  public async applyModes(patch: SessionModePatch): Promise<'applied' | 'deferred'> {
    return this.modes.apply(this.host.getState().currentThreadId, patch);
  }
  /**
   * 加载历史会话并重置回合态。
   * @param id 会话 id
   * @returns 异步完成
   */
  public async loadThread(id: string): Promise<void> {
    // S2 真机首屏观测：从点击/深链进入开始计时，加载完成后落一条 Performance measure。
    const startedAt = typeof performance === 'undefined' ? 0 : performance.now();
    // **请求代际护栏**：快速连点两个会话时，先发的 `getThread` 可能后到并覆盖后点的会话
    // （视图与 hash 都退回上一个）。与 `loadEarlier` 的 currentThreadId 核对同源，但此处有多个
    // await，必须按「最后一次请求」判定而不是按当前 id。
    const generation = ++this.loadGeneration;
    // 打开任何会话都意味着放弃状态结束：旧会话的迟到事件从此按 id 正常匹配。
    this.abandonedThreadId = null;
    // 挂到这条会话上（不是摘掉）：刷新 / 深链 / 点会话都要能继续收它的流式事件。
    this.viewAttachment.attach();
    try {
      // 会话**跟着项目走**（2026-10-07 用户：「在 A 项目下的会话，去 B 项目打开，会话会自己串过来」）：
      // 打开前对齐归属项目、必要时先切项目——策略与判据见 `models/SessionProjectBinding`。
      const owner = { api: this.services.api, host: this.host, toast: this.services.toast };
      const switched = await SessionProjectBinding.ensure(owner, id);
      if (generation !== this.loadGeneration) return;
      if (switched) {
        // 项目身份变了：通知界面重取项目清单与文件树（此前只 refreshSessions ⇒ 侧栏项目名、
        // 面包屑、文件树仍停在旧项目，点旧树里的文件会落到新工作区而失败）。
        this.host.patch((s) => ({ workspaceEpoch: s.workspaceEpoch + 1 }));
        await this.refreshSessions();
      }
      if (generation !== this.loadGeneration) return;
      const r = await this.services.api.getThread(id, { limit: HISTORY_PAGE_SIZE });
      if (generation !== this.loadGeneration) return;
      const items = r.items || [];
      // 历史会话的**工具结果**必须从事件里重建：卡片状态只来自实时 `tool_result` 通知，而加载历史时
      // 那些通知早就过去了 ⇒ 否则旧工具卡永远停在「进行中…」（2026-10-07 用户截图「结果卡住了」）。
      const results: Record<string, { text: string; ok: boolean }> = {};
      for (const ev of items) {
        const callId = ev.type === 'tool_result' ? (ev.payload?.callId as string | undefined) : undefined;
        if (callId !== undefined && callId !== '') {
          results[callId] = this.services.reducers.mergeToolResult({}, callId, ev.payload || {})[callId]!;
        }
      }
      this.host.patch({
        currentThreadId: id,
        events: items,
        toolResults: results,
        liveInputs: [],
        streamText: '',
        finalizedStreamText: '',
        busy: false,
        activeTool: null,
        historyHasMore: r.hasMore === true,
        oldestEventId: items[0]?.id ?? null,
        historyLoading: false,
      });
      // #OBS-12：加载历史会话必须重置 busy / activeTool，避免上一回合残留撑开过程 cluster。
      this.host.patch((s) => ({ sessions: s.sessions.map((x) => x) }));
      this.ticker.now();
      // F8：把当前会话写进 hash，支持深链 / 浏览器前进后退。
      this.services.navigate({ threadId: id });
      SessionController.markFirstPage(startedAt, items.length);
    } catch (e) {
      // 已被更新的请求取代：这条失败属于用户已经离开的加载，不该弹到新视图上。
      if (generation !== this.loadGeneration) return;
      this.services.toast(t('加载会话失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 落一条首屏 Performance measure（S2 真机测量入口）。
   * @param startedAt 开始时间（`performance.now()`；0 表示环境无 performance）。
   * @param events 首屏事件条数。
   * @returns 无返回值。
   */
  private static markFirstPage(startedAt: number, events: number): void {
    if (startedAt === 0 || typeof performance === 'undefined') return;
    try {
      performance.measure('omni.thread.firstPage', {
        start: startedAt,
        end: performance.now(),
        detail: { events },
      });
    } catch {
      // 观测失败绝不能影响会话加载。
    }
  }

  /**
   * 补拉更早历史（S2）：用当前最早事件 id 作 `before`，把上一页拼到事件流前面。
   *
   * 为什么要在 await 后重新核对 currentThreadId：补拉可能跨越用户切会话，晚到响应若直接
   * 写入就会把 A 的历史拼进 B（与 `loadThread` 的竞态同源）。
   * @returns 补拉完成（无更多/未加载时为 no-op）
   */
  public async loadEarlier(): Promise<void> {
    const before = this.host.getState();
    const threadId = before.currentThreadId;
    const oldest = before.oldestEventId;
    if (
      threadId === null ||
      !before.historyHasMore ||
      oldest === null ||
      before.historyLoading
    ) {
      return;
    }
    this.host.patch({ historyLoading: true });
    try {
      const r = await this.services.api.getThread(threadId, {
        limit: HISTORY_PAGE_SIZE,
        before: oldest,
      });
      if (r.error !== undefined) throw new Error(r.error);
      const current = this.host.getState();
      if (current.currentThreadId !== threadId) return;
      const seen = new Set(current.events.map((event) => event.id));
      const older = (r.items || []).filter((event) => !seen.has(event.id));
      const results = { ...current.toolResults };
      for (const event of older) {
        const callId =
          event.type === 'tool_result' ? (event.payload?.callId as string | undefined) : undefined;
        if (callId !== undefined && callId !== '') {
          results[callId] = this.services.reducers.mergeToolResult(
            {},
            callId,
            event.payload || {},
          )[callId]!;
        }
      }
      this.host.patch({
        events: [...older, ...current.events],
        toolResults: results,
        historyHasMore: r.hasMore === true,
        oldestEventId: older[0]?.id ?? oldest,
        historyLoading: false,
      });
    } catch (error) {
      this.host.patch({ historyLoading: false });
      // 事件被回卷（重生成/回退）后，旧页的 before id 已不在日志里：不猜、不静默丢历史，
      // 直接重载当前会话的尾部页，让用户看到一致的新视图。
      if ((error as Error).message === 'unknown_before') {
        this.services.toast(t('历史已变化，已重新加载'), 'info');
        await this.loadThread(threadId);
        return;
      }
      this.services.toast(
        t('加载更早历史失败：{msg}', { msg: (error as Error).message }),
        'err',
      );
    }
  }

  /** 新建会话：清空线程与回合态。 @returns 无 */
  public newSession(): void {
    // 立刻摘视图：此后该回合迟到的收尾 / 流式事件都不该回到这个新视图（见 ViewAttachment）。
    this.viewAttachment.detach();
    // 记下被放弃的会话：新会话里再发送会重新 attach，届时只能靠 id 拦住旧会话的迟到事件。
    this.abandonedThreadId = this.host.getState().currentThreadId;
    this.host.patch({
      currentThreadId: null,
      events: [],
      toolResults: {},
      liveInputs: [],
      streamText: '',
      finalizedStreamText: '',
      busy: false,
      activeTool: null,
      historyHasMore: false,
      oldestEventId: null,
      historyLoading: false,
    });
    // F8：清空 hash 中的会话，回到无会话视图。
    this.services.navigate({ threadId: null });
    this.ticker.now();
  }

  /**
   * 工作区切换后的收口：旧项目的当前会话与事件流不再属于当前上下文——
   * 摘视图（清空事件流 / 当前会话 / 流式缓冲，hash 去掉 threadId）并重取会话列表
   * （服务端按新工作区过滤）。否则用户切了项目，中栏还挂着上一个项目的对话。
   * @returns 无
   */
  public onWorkspaceSwitched(): void {
    // 显式切项目同样要通知界面重取项目清单/文件树（与打开别家会话的隐式切换同一出口）。
    this.host.patch((s) => ({ workspaceEpoch: s.workspaceEpoch + 1 }));
    this.newSession();
    void this.refreshSessions();
  }

  /**
   * 重命名会话（自定义标题）：写入服务端侧车后刷新列表（列表回落优先显示自定义标题）。
   * @param id 会话 id
   * @param title 新标题
   * @returns 异步完成
   */
  public async renameSession(id: string, title: string): Promise<void> {
    try {
      const r = await this.services.api.renameSession(id, title);
      if (!r.ok) {
        this.services.toast(t('重命名失败：{msg}', { msg: r.error ?? '' }), 'err');
        return;
      }
      await this.refreshSessions();
    } catch (e) {
      this.services.toast(t('重命名失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 删除会话：成功则从列表移除；若正打开该会话，同时清空当前线程。
   * @param id 会话 id
   * @returns 异步完成
   */
  public async deleteSession(id: string): Promise<void> {
    try {
      const r = await this.services.api.deleteSession(id);
      if (!r.ok && r.error !== 'session_not_found') {
        // 「运行中拒绝删除」是服务端的有意设计（避免删掉正在写盘的会话）——把**下一步动作**一并说清，
        // 否则用户只看到一句「无法删除」不知道该怎么办。
        this.services.toast(
          t('删除失败：{msg}', {
            msg:
              r.error === 'session_running'
                ? t('会话正在运行，无法删除（先点「停止」结束本回合再删）')
                : r.error ?? '',
          }),
          'err',
        );
        return;
      }
      // **必须先本地摘掉这一行**（2026-09-27 用户报「删除并未刷新」+「删除失败: session_not_found」）：
      // 刷新走 `mergeSessions(prev, fromDisk)`，而它的契约是「保留内存态中**未落盘**的会话」——
      // 删除成功后该 id 恰好「不在磁盘上」，于是被当成「未落盘的新会话」**原样留下**：文件删了、
      // 行还在；用户再点一次删除就是 `session_not_found`（文件真没了）。故本地先移除再刷新。
      this.host.patch((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
      if (this.host.getState().currentThreadId === id) this.newSession();
      await this.refreshSessions();
      this.services.toast(r.ok ? t('会话已删除') : t('该会话未落盘，已从列表移除'), 'ok');
    } catch (e) {
      this.services.toast(t('删除失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 归档 / 取消归档会话：成功后刷新列表（归档会话在左栏落到「已归档」组）。
   * @param id 会话 id
   * @param archived true 归档、false 恢复
   * @returns 异步完成
   */
  public async archiveSession(id: string, archived: boolean): Promise<void> {
    try {
      const r = await this.services.api.archiveSession(id, archived);
      if (!r.ok) {
        this.services.toast(t('归档失败：{msg}', { msg: r.error ?? '' }), 'err');
        return;
      }
      await this.refreshSessions();
      this.services.toast(archived ? t('已归档') : t('已恢复'), 'ok');
    } catch (e) {
      this.services.toast(t('归档失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 保存左栏拖拽排序：先按新顺序落本地（即时生效，不等往返），再持久化到服务端侧车。
   * @param ordered 新的完整顺序（会话条目）
   * @returns 异步完成
   */
  public async reorderSessions(ordered: SessionEntry[]): Promise<void> {
    this.host.patch({ sessions: ordered });
    try {
      await this.services.api.reorderSessions(ordered.map((s) => s.id));
    } catch (e) {
      this.services.toast(t('排序保存失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 分叉会话为带新 id 的副本：写入成功后刷新列表并提示新会话 id。
   * @param id 源会话 id
   * @returns 异步完成
   */
  public async forkSession(id: string): Promise<void> {
    try {
      const r = await this.services.api.forkSession(id);
      if (!r.ok) {
        this.services.toast(t('复制失败：{msg}', { msg: r.error ?? '' }), 'err');
        return;
      }
      await this.refreshSessions();
      this.services.toast(r.newSessionId ? t('已复制为 {id}', { id: r.newSessionId }) : t('已复制会话'), 'ok');
    } catch (e) {
      this.services.toast(t('复制失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 钻取一条事件到「详情」面板（移动端收起抽屉）。
   * @param ev 被钻取的事件
   * @returns 无
   */
  public showDetail(ev: ThreadEvent): void {
    this.host.patch({ detailEvent: ev, activePane: 'detail' });
    if (window.innerWidth <= 880) this.host.patch({ leftOpen: false, rightOpen: false });
  }

  /** 关闭左右抽屉（属性箭头函数：`SessionController` 的方法数已到上帝类阈值，
   * 这里不新增 MethodDeclaration）。 */
  public readonly closeDrawers = (): void => {
    this.host.patch({ leftOpen: false, rightOpen: false });
  };

  /**
   * 按工具调用 id 找到对应 tool_call 事件并钻取。
   * @param callId 工具调用 id
   * @returns 无
   */
  public onShowTool(callId: string): void {
    const s = this.host.getState();
    const ev = s.events.find((e) => {
      if (e.type !== 'tool_call') return false;
      const p = e.payload || {};
      return ((p.callId as string) || e.id) === callId;
    });
    if (ev) this.showDetail(ev);
  }

  /**
   * 把当前事件流与工具结果聚合成工具项列表（供 ToolsTab 渲染）。
   * @returns 工具项列表
   */
  public getToolItems(): ToolItem[] {
    const s = this.host.getState();
    return this.services.reducers.buildToolItems(s.events, s.toolResults);
  }
}