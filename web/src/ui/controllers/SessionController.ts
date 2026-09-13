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
    this.host.patch((s) => ({ events: this.services.reducers.appendEvent(s.events, ev) }));
    if (ev.type === 'tool_result') {
      const callId = p.callId as string;
      if (callId) {
        this.host.patch((s) => ({ toolResults: this.services.reducers.mergeToolResult(s.toolResults, callId, p) }));
      }
    }
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
        busy: false,
        activeTool: null,
      });
      // #OBS-12：加载历史会话必须重置 busy / activeTool，避免上一回合残留撑开过程 cluster。
      this.host.patch((s) => ({ sessions: s.sessions.map((x) => x) }));
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
      busy: false,
      activeTool: null,
    });
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
