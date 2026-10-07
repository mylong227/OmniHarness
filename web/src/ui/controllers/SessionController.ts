// 会话 / 事件 / 文件相关控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中与会话、事件流、工具结果、文件预览、钻取、抽屉相关的回调，
// 一律经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.js';
import type { ThreadEvent } from '../../types/models.js';
import type { SessionEntry, ToolItem } from '../shared.js';
import { TurnStreamBuffer } from '../models/TurnStreamBuffer.js';
import { SessionsScope } from '../models/SessionsScope.js';
import { DeferredModes } from '../models/DeferredModes.js';
import { ViewAttachment } from '../models/ViewAttachment.js';
import type { SessionModePatch } from '../models/PendingModes.js';
import { MethodBinder } from './methodBinder.js';

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

  /** 新回合开始：开一份干净的流式缓冲（每个回合一份，见 TurnStreamBuffer）。 @returns 无 */
  public openStream(): void {
    this.stream.open();
  }

  /**
   * 收尾本回合的流式增量：把缓冲区里最后一段刷进状态，再释放节流器。
   *
   * **必须在写最终 assistant 事件 / 把 `streamText` 收口为 `finalizedStreamText` 之前调用**，
   * 否则最后一段增量会丢（这正是节流「零丢失」不变量的兜底点）。
   * @returns 无
   */
  public flushStream(): void {
    this.stream.flush();
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
    // 挂到这条会话上（不是摘掉）：刷新 / 深链 / 点会话都要能继续收它的流式事件。
    this.viewAttachment.attach();
    try {
      const r = await this.services.api.getThread(id);
      this.host.patch({
        currentThreadId: id,
        events: r.items || [],
        toolResults: {},
        liveInputs: [],
        streamText: '',
        finalizedStreamText: '',
        busy: false,
        activeTool: null,
      });
      // #OBS-12：加载历史会话必须重置 busy / activeTool，避免上一回合残留撑开过程 cluster。
      this.host.patch((s) => ({ sessions: s.sessions.map((x) => x) }));
      // F8：把当前会话写进 hash，支持深链 / 浏览器前进后退。
      this.services.navigate({ threadId: id });
    } catch (e) {
      this.services.toast('加载会话失败：' + (e as Error).message, 'err');
    }
  }

  /** 新建会话：清空线程与回合态。 @returns 无 */
  public newSession(): void {
    // 立刻摘视图：此后该回合迟到的收尾 / 流式事件都不该回到这个新视图（见 ViewAttachment）。
    this.viewAttachment.detach();
    this.host.patch({
      currentThreadId: null,
      events: [],
      toolResults: {},
      liveInputs: [],
      streamText: '',
      finalizedStreamText: '',
      busy: false,
      activeTool: null,
    });
    // F8：清空 hash 中的会话，回到无会话视图。
    this.services.navigate({ threadId: null });
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
        this.services.toast('重命名失败：' + (r.error ?? ''), 'err');
        return;
      }
      await this.refreshSessions();
    } catch (e) {
      this.services.toast('重命名失败：' + (e as Error).message, 'err');
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
          '删除失败：' +
            (r.error === 'session_running'
              ? '会话正在运行，无法删除（先点「停止」结束本回合再删）'
              : r.error ?? ''),
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
      this.services.toast(r.ok ? '会话已删除' : '该会话未落盘，已从列表移除', 'ok');
    } catch (e) {
      this.services.toast('删除失败：' + (e as Error).message, 'err');
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
        this.services.toast('归档失败：' + (r.error ?? ''), 'err');
        return;
      }
      await this.refreshSessions();
      this.services.toast(archived ? '已归档' : '已恢复', 'ok');
    } catch (e) {
      this.services.toast('归档失败：' + (e as Error).message, 'err');
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
      this.services.toast('排序保存失败：' + (e as Error).message, 'err');
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
        this.services.toast('复制失败：' + (r.error ?? ''), 'err');
        return;
      }
      await this.refreshSessions();
      this.services.toast(r.newSessionId ? '已复制为 ' + r.newSessionId : '已复制会话', 'ok');
    } catch (e) {
      this.services.toast('复制失败：' + (e as Error).message, 'err');
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

  /** 关闭左右抽屉。 @returns 无 */
  public closeDrawers(): void {
    this.host.patch({ leftOpen: false, rightOpen: false });
  }

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
