// 会话 / 事件 / 文件相关控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中与会话、事件流、工具结果、文件预览、钻取、抽屉相关的回调，
// 一律经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.js';
import type { ThreadEvent } from '../../types/models.js';
import type { SessionEntry, ToolItem } from '../shared.js';
import { langOf } from '../highlight.js';

/** 会话 / 事件 / 文件控制器：单一职责，仅供 App 组合使用。 */
export class SessionController {
  /** 状态宿主。 */
  private readonly host: AppHost;
  /** 共享服务。 */
  private readonly services: AppServices;

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
   * @param params 增量载荷（含 text 增量片段）
   * @returns 无
   */
  public appendTextDelta(params: Record<string, unknown>): void {
    const text = typeof params.text === 'string' ? params.text : '';
    if (text === '') return;
    this.host.patch((s) => ({ streamText: this.services.reducers.appendTextDelta(s.streamText, text) }));
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
        activePane: 'file',
        rightOpen: true,
      });
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
