// 会话 / 事件 / 文件相关控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中与会话、事件流、工具结果、文件预览、钻取、抽屉相关的回调，
// 一律经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.js';
import type { ThreadEvent } from '../../types/models.js';
import type { SessionEntry, ToolItem } from '../shared.js';
import { langOf } from '../highlight.js';
import { StreamThrottle } from '../models/StreamThrottle.js';

/** 会话 / 事件 / 文件控制器：单一职责，仅供 App 组合使用。 */
export class SessionController {
  /** 状态宿主。 */
  private readonly host: AppHost;
  /** 共享服务。 */
  private readonly services: AppServices;
  /**
   * 本回合的流式增量节流器（无回合进行中时为 null）。
   *
   * 一个回合一个实例：回合结束（或用户中断）时 `flush()` 后 `dispose()`，之后迟到的增量一律无效。
   * 这样既把高频 setState 压到有界频率，又不会让「停止」之后被迟到 delta 重新点亮流式卡片。
   */
  private throttle: StreamThrottle | null = null;

  /**
   * 构造并绑定对外回调。
   * @param host 状态宿主
   * @param services 共享服务
   */
  public constructor(host: AppHost, services: AppServices) {
    this.host = host;
    this.services = services;
    this.handleEvent = this.handleEvent.bind(this);
    this.appendTextDelta = this.appendTextDelta.bind(this);
    this.updateToolInput = this.updateToolInput.bind(this);
    this.refreshSessions = this.refreshSessions.bind(this);
    this.loadThread = this.loadThread.bind(this);
    this.newSession = this.newSession.bind(this);
    this.openFile = this.openFile.bind(this);
    this.showDetail = this.showDetail.bind(this);
    this.closeDrawers = this.closeDrawers.bind(this);
    this.onShowTool = this.onShowTool.bind(this);
  }

  /**
   * 处理一条事件流事件：tool_call 清增量并记活动工具、assistant/reasoning 清活动工具、
   * 末尾追加事件、tool_result 合并结果。
   * @param ev 事件
   * @returns 无
   */
  public handleEvent(ev: ThreadEvent): void {
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
   * 增量**先过 `StreamThrottle` 再进状态**：长回答的 `text_delta` 可达数千条，逐条 setState 会让
   * 整棵中栏重渲染 ⇒ 掉帧。节流器把刷新压到 ≤1 次/50ms，累计文本与逐条拼接完全一致（收尾 flush 兜底）。
   *
   * 仅在回合进行中（busy）累积：回合已结束 / 已被用户中断后到达的迟到增量一律丢弃，
   * 否则「停止」之后流式卡片会被迟到 delta 重新点亮（留下 streaming 残留）。
   * @param params 增量载荷（含 text 增量片段）
   * @returns 无
   */
  public appendTextDelta(params: Record<string, unknown>): void {
    if (!this.host.getState().busy) {
      // 非忙碌态：顺手释放节流器，让此后任何迟到增量连缓冲都进不去（与既有 busy 护栏同向叠加）。
      this.disposeThrottle();
      return;
    }
    const text = typeof params.text === 'string' ? params.text : '';
    if (text === '') return;
    this.throttleFor().push(text);
  }

  /**
   * 收尾本回合的流式增量：把缓冲区里最后一段刷进状态，再释放节流器。
   *
   * **必须在写最终 assistant 事件 / 把 `streamText` 收口为 `finalizedStreamText` 之前调用**，
   * 否则最后一段增量会丢（这正是节流「零丢失」不变量的兜底点）。
   * @returns 无
   */
  public flushStream(): void {
    this.throttle?.flush();
    this.disposeThrottle();
  }

  /**
   * 取本回合节流器（惰性创建）。
   * @returns 节流器实例
   */
  private throttleFor(): StreamThrottle {
    if (this.throttle === null) {
      this.throttle = new StreamThrottle((text) => {
        this.host.patch((s) => ({
          streamText: this.services.reducers.appendTextDelta(s.streamText, text),
        }));
      });
    }
    return this.throttle;
  }

  /**
   * 释放节流器（幂等）。
   * @returns 无
   */
  private disposeThrottle(): void {
    this.throttle?.dispose();
    this.throttle = null;
  }

  /**
   * 合并一条工具增量输入。
   * @param params 增量载荷
   * @returns 无
   */
  public updateToolInput(params: Record<string, unknown>): void {
    this.host.patch((s) => ({ liveInputs: this.services.reducers.mergeToolInput(s.liveInputs, params) }));
  }

  /**
   * 刷新磁盘会话列表（含各项目工作区标记），保留内存态中未落盘的会话。
   * @returns 异步完成
   */
  public async refreshSessions(): Promise<void> {
    try {
      const r = await this.services.api.listSessions();
      const fromDisk: SessionEntry[] = r.sessions.map((s) => ({
        id: s.sessionId,
        label: s.label || s.sessionId,
        workspace: s.workspace,
        updatedAt: s.updatedAt,
        turns: s.turns,
        running: s.running === true,
      }));
      this.host.patch((s) => ({ sessions: this.services.reducers.mergeSessions(s.sessions, fromDisk) }));
    } catch {
      /* 静默：列表不可用时保留内存态 */
    }
  }

  /**
   * 加载历史会话并重置回合态。
   * @param id 会话 id
   * @returns 异步完成
   */
  public async loadThread(id: string): Promise<void> {
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
      if (!r.ok) {
        this.services.toast('删除失败：' + (r.error === 'session_running' ? '会话正在运行，无法删除' : r.error ?? ''), 'err');
        return;
      }
      if (this.host.getState().currentThreadId === id) this.newSession();
      await this.refreshSessions();
      this.services.toast('会话已删除', 'ok');
    } catch (e) {
      this.services.toast('删除失败：' + (e as Error).message, 'err');
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
   * 在右侧文件面板打开一个路径（含语法高亮语言推断）。
   * F8：面板经路由写入 hash，刷新 / 前进后退可还原「正在看哪个文件」这一视图。
   * @param path 文件路径
   * @returns 异步完成
   */
  public async openFile(path: string): Promise<void> {
    try {
      const r = await this.services.api.readFs(path);
      const meta = (r.isBinary ? '二进制文件' : r.truncated ? '已截断（>200KB）' : '') + ' · ' + (r.size ?? 0) + ' 字节';
      this.host.patch({
        fileView: {
          title: '📄 ' + r.path,
          meta: meta.trim(),
          content: r.isBinary ? '（二进制文件，无法预览）' : r.content || '',
          // 依据路径推断语言做语法高亮；二进制不参与。
          lang: r.isBinary ? '' : langOf(r.path),
        },
      });
      // 展开右栏与激活面板由路由收口（RouteBinding.apply），避免两处状态各写一遍。
      this.services.navigate({ pane: 'file' });
    } catch (e) {
      this.services.toast('打开失败：' + (e as Error).message, 'err');
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
