// 应用根组件（App）的纯状态归约函数集合，封装为单一类（一文件一类）。
//
// 设计意图：把原本内联在 App 组件体内的所有「(prev) => 新状态」变换抽成
// 无副作用、无 React 依赖的纯方法，便于单测（D6 护栏）与「容器控制器 + 纯视图」分层
// （C3）。搬运自 useAppController 的对应回调闭包，行为逐字节等价，不引入新语义。

import type {
  GraphDone,
  GraphProgress,
  GraphRunState,
  GraphStatusResult,
  ThreadEvent,
} from '../../types/models.js';
import type { CommandItem } from '../components/CommandPalette.js';
import { KeyboardShortcuts } from '../models/KeyboardShortcuts.js';
import type { LiveInput, SessionEntry, ToolItem, ToolResultView } from '../shared.js';

/** 命令面板回调依赖（buildCommands 所需）。 */
export interface CommandDeps {
  setActivePane: (key: string) => void;
  setRightOpen: (open: boolean) => void;
  newSession: () => void;
  refreshSessions: () => void | Promise<void>;
  toggleTheme: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
}

/** 应用根组件的纯状态归约器：无状态、无 React 依赖，全部为可单测的纯方法。 */
export class AppReducers {
  /** 快捷键文案来源（与全局 keydown 解析共用同一份绑定表，杜绝提示与行为漂移）。 */
  private readonly shortcuts = new KeyboardShortcuts();

  /**
   * 向事件流追加一条事件（**同一 id 只认第一次**）。
   *
   * 为什么必须按 id 去重（2026-10-07 用户实测：「原本会话下继续发一条话后，滚轮从下向上滚，渲染内容
   * 就会重复变越来越多」）：事件流的投递是**至少一次**语义——SSE 重连补发、resume 回放、双订阅都可能
   * 把同一条事件再投一次，而这里此前是无条件追加 ⇒ 重复事件在中栏里越堆越多（虚拟化滚动时才逐段显形，
   * 于是症状是"往上滚就越来越多"），右下角事件数也一起涨。事件 id 由服务端生成且全局唯一，
   * 按 id 去重不会误伤任何正常事件。
   * @param prev 既有事件流
   * @param ev 待追加的事件
   * @returns 追加后的事件流（重复 id 时原样返回，引用不变 ⇒ 不触发无谓重渲染）
   */
  public appendEvent(prev: ThreadEvent[], ev: ThreadEvent): ThreadEvent[] {
    if (AppReducers.alreadyIngested(prev, ev)) return prev;
    return [...prev, ev];
  }

  /**
   * 该事件是否已在流里（按 id）。
   * @param prev 既有事件流
   * @param ev 待判定事件
   * @returns 已存在返回 true（id 缺失/空串时视为"无法判定" ⇒ false）
   */
  private static alreadyIngested(prev: readonly ThreadEvent[], ev: ThreadEvent): boolean {
    const id = ev.id;
    if (typeof id !== 'string' || id === '') return false;
    return prev.some((e) => e.id === id);
  }

  /**
   * 追加一段模型正文增量（流式渲染用）。
   *
   * 后端 `onText` 回传的是**增量片段**（非累积全文，见各 model adapter 的 handleStreamEvent），
   * 故此处必须拼接；若哪天上游改成累积语义，这里会立刻表现为文本重复，是显式的失败而非静默错。
   *
   * @param prev 已累积的流式文本
   * @param text 增量片段
   * @returns 拼接后的文本
   */
  public appendTextDelta(prev: string, text: string): string {
    return prev + text;
  }

  /**
   * 把一条事件并入状态，并处理「流式文本收口」。
   *
   * assistant 事件意味着本轮这段正文已落成**事实事件**：此后到达的增量属于下一段生成，
   * 必须从空缓冲重新累积（否则一个回合内的多段正文会串成一条，前端显示与实际不符）。
   * 收口时把刚流过的文本记入 finalizedStreamText，供视图判断这条 assistant 卡片还要不要做
   * 渐进揭示——已经逐字看过的内容再播一遍动画会从 40% 处「跳回去」，是可见的倒退。
   * 该标记在同回合内保持（下一个 assistant 事件覆盖它），回合开始时由 send/loadThread 清零。
   *
   * @param prev 既有事件流 / 流式文本 / 已收口文本
   * @param ev 待并入的事件
   * @returns 状态补丁（events / streamText / finalizedStreamText）
   */
  public ingestEvent(
    prev: { events: ThreadEvent[]; streamText: string; finalizedStreamText: string },
    ev: ThreadEvent,
  ): { events: ThreadEvent[]; streamText: string; finalizedStreamText: string } {
    // 与 appendEvent 同一条去重纪律（同一 id 只认第一次）：重投的 assistant 事件若照收，还会顺带把
    // streamText 清空、finalizedStreamText 覆盖，让正在流的那段正文的收口判断一起错位。
    if (AppReducers.alreadyIngested(prev.events, ev)) {
      return { events: prev.events, streamText: prev.streamText, finalizedStreamText: prev.finalizedStreamText };
    }
    const events = [...prev.events, ev];
    if (ev.type === 'assistant' && prev.streamText !== '') {
      return { events, streamText: '', finalizedStreamText: prev.streamText };
    }
    return { events, streamText: prev.streamText, finalizedStreamText: prev.finalizedStreamText };
  }

  /**
   * 合并一条工具结果到结果映射。
   * @param prev 既有结果映射
   * @param callId 工具调用 id
   * @param p 工具结果载荷
   * @returns 合并后的结果映射
   */
  public mergeToolResult(
    prev: Record<string, ToolResultView>,
    callId: string,
    p: Record<string, unknown>,
  ): Record<string, ToolResultView> {
    const ok = p.ok === true;
    const text =
      p.error != null
        ? '✗ ' + String(p.error)
        : p.output != null
          ? String(p.output)
          : ok
            ? '✓ 成功'
            : '✗ 失败';
    return { ...prev, [callId]: { text, ok } };
  }

  /**
   * 合并一条工具增量输入。
   * @param prev 既有增量列表
   * @param params 增量载荷（含 id / name / partialJson）
   * @returns 合并后的增量列表
   */
  public mergeToolInput(prev: LiveInput[], params: Record<string, unknown>): LiveInput[] {
    const id = params.id as string;
    if (!id) return prev;
    const exists = prev.find((l) => l.id === id);
    if (exists) {
      return prev.map((l) => (l.id === id ? { ...l, partial: (params.partialJson as string) || '' } : l));
    }
    return [...prev, { id, name: (params.name as string) || 'tool', partial: (params.partialJson as string) || '' }];
  }

  /**
   * 应用一次 graph 进度事件。
   * @param prev 既有运行态映射
   * @param p graph 进度载荷
   * @returns 合并后的运行态映射
   */
  public applyGraphProgress(
    prev: Record<string, GraphRunState>,
    p: GraphProgress,
  ): Record<string, GraphRunState> {
    if (!p || p.runId === undefined) return prev;
    const run: GraphRunState =
      prev[p.runId] ??
      {
        runId: p.runId,
        defName: '',
        done: false,
        ok: undefined,
        nodes: [],
        blackboard: undefined,
        error: undefined,
      };
    const nodes = new Map(run.nodes.map((n) => [n.id, n]));
    nodes.set(p.id, { id: p.id, status: p.status, error: p.error, steps: p.steps, durationMs: p.durationMs });
    return { ...prev, [p.runId]: { ...run, nodes: Array.from(nodes.values()) } };
  }

  /**
   * 应用一次 graph 完成事件。
   * @param prev 既有运行态映射
   * @param p graph 完成载荷
   * @returns 合并后的运行态映射
   */
  public applyGraphDone(
    prev: Record<string, GraphRunState>,
    p: GraphDone,
  ): Record<string, GraphRunState> {
    if (!p || p.runId === undefined) return prev;
    const run = prev[p.runId];
    if (!run) return prev;
    return { ...prev, [p.runId]: { ...run, done: true, ok: p.ok, blackboard: p.blackboard, error: p.error } };
  }

  /**
   * 构造 graph 运行的初始态。
   * @param runId 运行 id
   * @param name 编排定义名
   * @returns 初始运行态
   */
  public buildGraphRunInitial(runId: string, name: string): GraphRunState {
    return {
      runId,
      defName: name,
      done: false,
      ok: undefined,
      nodes: [],
      blackboard: undefined,
      error: undefined,
    };
  }

  /**
   * 把一次 graph 轮询快照合并进运行态。
   * @param prev 既有运行态映射
   * @param runId 运行 id
   * @param st 轮询快照
   * @returns 合并后的运行态映射
   */
  public applyGraphStatus(
    prev: Record<string, GraphRunState>,
    runId: string,
    st: GraphStatusResult,
  ): Record<string, GraphRunState> {
    const run: GraphRunState =
      prev[runId] ??
      {
        runId,
        defName: st.defName || '',
        done: false,
        ok: undefined,
        nodes: [],
        blackboard: undefined,
        error: undefined,
      };
    const nodes = new Map(run.nodes.map((n) => [n.id, n]));
    (st.nodes || []).forEach((n) => nodes.set(n.id, n));
    return {
      ...prev,
      [runId]: {
        ...run,
        defName: st.defName,
        done: st.done,
        ok: st.ok,
        blackboard: st.blackboard,
        error: st.error,
        nodes: Array.from(nodes.values()),
      },
    };
  }

  /**
   * 以磁盘响应为准合并会话列表：同 id 覆盖；**消失的 id 一律移除**，唯一例外是
   * 「已归档」（快速刷新路径不扫归档目录，见 `refreshSessions`，靠本规则保住「已归档」组）。
   *
   * 为什么不能「保留在册未落盘的会话」（旧契约，2026-10-07 推翻）：服务端 `sessions.list`
   * 按当前工作区过滤——切到别的项目后，旧项目的会话正好「不在响应里」，旧契约会把它们
   * 永久留在内存列表 ⇒ 用户报「切换工作区，会话列表还显示之前的会话」。真正只存在内存
   * 的会话并不存在（会话由服务端创建、先落盘后返回 id）；删除路径也已改为本地先摘行
   * （见 `sessionDeleteRefresh.test.mjs` 的三条判据）。
   * @param prev 当前内存列表
   * @param fromDisk 服务端响应（线格式已映射为 SessionEntry）
   * @returns 合并后的新列表
   */
  public mergeSessions(prev: SessionEntry[], fromDisk: SessionEntry[]): SessionEntry[] {
    const ids = new Set(fromDisk.map((s) => s.id));
    const keptArchived = prev.filter((s) => !ids.has(s.id) && s.archived === true);
    return [...keptArchived, ...fromDisk];
  }

  /**
   * 把事件流聚合成工具项列表。
   * @param events 事件流
   * @param toolResults 工具结果映射
   * @returns 工具项列表
   */
  public buildToolItems(events: ThreadEvent[], toolResults: Record<string, ToolResultView>): ToolItem[] {
    const items: ToolItem[] = [];
    for (const e of events) {
      if (e.type !== 'tool_call') continue;
      const p = e.payload || {};
      const callId = (p.callId as string) || e.id;
      const res = toolResults[callId];
      items.push({ callId, name: (p.name as string) || 'tool', status: res ? (res.ok ? 'ok' : 'err') : 'pending' });
    }
    return items;
  }

  /**
   * 把 RPC 返回的 finalText 补成一条 assistant 事件（send 的兜底分支）。
   * 若流中已存在同内容 assistant 事件则跳过，避免重复。空/纯空白直接返回原数组。
   * @param prev 既有事件流
   * @param finalText RPC 返回的最终文本
   * @returns 追加后的事件流
   */
  public appendFinalText(prev: ThreadEvent[], finalText: string | undefined): ThreadEvent[] {
    if (finalText === undefined || finalText.trim() === '') return prev;
    // 只与**最后一条 assistant** 比（trim 归一）：比"任意历史 assistant 是否同文"会误伤——上一回合
    // 恰好同文时，本回合的兜底事件会被吞掉（**内容丢失**）；而比最后一条就足以判定"流里已经有过这条
    // 回复"。归一化掉首尾空白，避免模型最终文本与事件正文差一个换行就重复落一条（用户实测的"重复"）。
    const lastAssistant = AppReducers.lastAssistantOf(prev);
    if (lastAssistant !== undefined && String(lastAssistant.payload?.content ?? '').trim() === finalText.trim()) {
      return prev;
    }
    return [
      ...prev,
      {
        id: 'final-' + Date.now().toString(36),
        type: 'assistant',
        timestamp: Date.now(),
        payload: { content: finalText },
      } as ThreadEvent,
    ];
  }

  /**
   * 取事件流里最后一条 assistant 事件。
   * @param events 事件流
   * @returns 最后一条 assistant 事件；没有则 undefined
   */
  private static lastAssistantOf(events: readonly ThreadEvent[]): ThreadEvent | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev !== undefined && ev.type === 'assistant') return ev;
    }
    return undefined;
  }

  /**
   * 构造命令面板的命令集（切换面板 / 会话 / 界面）。
   * @param deps 命令执行所需的回调集合
   * @returns 命令项列表
   */
  public buildCommands(deps: CommandDeps): CommandItem[] {
    const panes: { key: string; label: string }[] = [
      { key: 'tools', label: '工具' },
      { key: 'metrics', label: '指标' },
      { key: 'settings', label: '设置' },
      { key: 'plugins', label: '插件' },
      { key: 'graph', label: '编排' },
      { key: 'memory', label: '记忆' },
      { key: 'profiles', label: '配置集' },
      { key: 'detail', label: '钻取' },
      { key: 'changes', label: '变更' },
      { key: 'rollback', label: '回滚' },
      { key: 'file', label: '文件' },
    ];
    const list: CommandItem[] = panes.map((p) => ({
      id: 'pane-' + p.key,
      label: '打开面板：' + p.label,
      group: '导航',
      run: () => {
        deps.setActivePane(p.key);
        deps.setRightOpen(true);
      },
    }));
    list.push(
      {
        id: 'new-session',
        label: '新建会话',
        group: '会话',
        hint: this.shortcuts.label('newSession'),
        run: () => deps.newSession(),
      },
      { id: 'reload-sessions', label: '刷新会话列表', group: '会话', run: () => void deps.refreshSessions() },
      {
        id: 'toggle-theme',
        label: '切换浅色 / 深色主题',
        group: '界面',
        hint: this.shortcuts.label('toggleTheme'),
        run: () => deps.toggleTheme(),
      },
      {
        id: 'toggle-left',
        label: '切换会话面板',
        group: '界面',
        hint: this.shortcuts.label('toggleLeft'),
        run: () => deps.toggleLeft(),
      },
      {
        id: 'toggle-right',
        label: '切换工具面板',
        group: '界面',
        hint: this.shortcuts.label('toggleRight'),
        run: () => deps.toggleRight(),
      },
    );
    return list;
  }
}
