// 应用根组件：装配 OO 服务层（ApiClient / EventStream / ToastService）、路由 SSE 消息到共享状态、
// 维护三栏布局与移动端抽屉、主题与 toast。所有 Tab 通过 React Context 取用 api / toast。

import { html, React, ReactDOM } from './deps.js';
import { AppContext } from './context.js';
import type { AppContextValue } from './context.js';
import type { ToastKind } from '../core/ToastService.js';
import { ApiClient } from '../core/ApiClient.js';
import { EventStream } from '../core/EventStream.js';
import { ToastService } from '../core/ToastService.js';
import type { ApprovalRequest, GraphProgress, GraphDone, SseEnvelope, ThreadEvent } from '../types/models.js';
import type { FileView, LiveInput, SessionEntry, ToastState, ToolItem } from './shared.js';
import type { ToolResultView } from './components/StreamView.js';

import { TopBar } from './components/TopBar.js';
import { SessionPanel } from './components/SessionPanel.js';
import { StreamView } from './components/StreamView.js';
import { RightPanel } from './components/RightPanel.js';
import { NavRail } from './components/NavRail.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { Toast } from './components/Toast.js';
import { Resizer } from './components/Resizer.js';

import { ToolsTab } from './components/tabs/ToolsTab.js';
import { MetricsTab } from './components/tabs/MetricsTab.js';
import { ChangesTab } from './components/tabs/ChangesTab.js';
import { SettingsTab } from './components/tabs/SettingsTab.js';
import { PluginsTab } from './components/tabs/PluginsTab.js';
import { GraphTab } from './components/tabs/GraphTab.js';
import { MemoryTab } from './components/tabs/MemoryTab.js';
import { ProfilesTab } from './components/tabs/ProfilesTab.js';
import { FileTab } from './components/tabs/FileTab.js';
import { DetailTab } from './components/tabs/DetailTab.js';

import type { GraphRunState } from '../types/models.js';

export function App(): ReactElement {
  const api = React.useMemo(() => new ApiClient(), []);
  const stream = React.useMemo(() => new EventStream(), []);
  const toastSvc = React.useMemo(() => new ToastService(), []);

  const [connected, setConnected] = React.useState(false);
  const [adapter, setAdapter] = React.useState('');
  const [activePane, setActivePane] = React.useState('tools');
  const [model, setModel] = React.useState('');
  /** 当前厂商可用模型清单（model.catalog 下发，Composer 下拉按此过滤）。 */
  const [modelOptions, setModelOptions] = React.useState<string[]>([]);
  const [providerLabel, setProviderLabel] = React.useState('');
  /**
   * 当前厂商合法的 reasoning_effort 档位（#B6 扩展，2026-09-08）：
   * undefined / [] 时 Composer 退回内置兜底 5 值；非空时按此列表渲染下拉，
   * 保证用户只会挑端点实际接受的值（DeepSeek 7 档 / OpenAI 5 档 / Anthropic 空）。
   */
  const [reasoningOptions, setReasoningOptions] = React.useState<string[] | undefined>(undefined);
  const [reasoning, setReasoning] = React.useState('');
  const [permission, setPermission] = React.useState('');
  const [events, setEvents] = React.useState<ThreadEvent[]>([]);
  const [toolResults, setToolResults] = React.useState<Record<string, ToolResultView>>({});
  const [liveInputs, setLiveInputs] = React.useState<LiveInput[]>([]);
  const [sessions, setSessions] = React.useState<SessionEntry[]>([]);
  const [currentThreadId, setCurrentThreadId] = React.useState<string | null>(null);
  const [detailEvent, setDetailEvent] = React.useState<ThreadEvent | null>(null);
  const [approval, setApproval] = React.useState<ApprovalRequest | null>(null);
  const [fileView, setFileView] = React.useState<FileView | null>(null);
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');
  const [leftOpen, setLeftOpen] = React.useState(false);
  const [rightOpen, setRightOpen] = React.useState(false);
  const [memoryReloadKey, setMemoryReloadKey] = React.useState(0);
  const [profilesReloadKey, setProfilesReloadKey] = React.useState(0);
  const [graphRuns, setGraphRuns] = React.useState<Record<string, GraphRunState>>({});
  const [busy, setBusy] = React.useState(false);
  const [activeTool, setActiveTool] = React.useState<string | null>(null);
  const [toastState, setToastState] = React.useState<ToastState>({ message: '', kind: 'info', visible: false });
  /** 左/右侧面板宽度（px），从 localStorage 恢复，可拖拽调整。 */
  const [leftWidth, setLeftWidth] = React.useState(248);
  const [rightWidth, setRightWidth] = React.useState(360);

  // ---- toast ----
  const showToast = React.useCallback((message: string, kind: ToastKind = 'info') => {
    setToastState({ message, kind, visible: true });
    window.setTimeout(
      () => setToastState((s) => (s.message === message ? { ...s, visible: false } : s)),
      2200,
    );
  }, []);
  React.useEffect(() => {
    toastSvc.bind(showToast);
  }, [toastSvc, showToast]);

  // ---- 当前厂商的可用模型清单（下拉只显示对应厂商能用的模型；检测/启用厂商后经 context 刷新） ----
  const refreshModelCatalog = React.useCallback(() => {
    api
      .modelCatalog()
      .then((cat) => {
        const active = cat.active;
        if (active) {
          setModelOptions(active.models);
          setProviderLabel(active.label);
          // 推理强度档位（#B6 扩展，2026-09-08）：undefined 表示 UI 用内置兜底；空数组表示该厂商无档位（隐藏下拉）。
          setReasoningOptions(active.reasoningEffort);
          // 持久化到 localStorage，刷新页面后仍能立即显示上次连上的可用模型列表。
          try {
            localStorage.setItem('omni-model-options', JSON.stringify(active.models));
            localStorage.setItem('omni-provider-label', active.label);
          } catch {
            /* 忽略 */
          }
          // 只有当前还没从 config 加载出 model 时，才用 catalog 的默认 model。
          // 避免 catalog 后返回覆盖用户已保存的选择。
          setModel((current) => (current ? current : active.model || current));
        }
      })
      .catch(() => {});
  }, [api]);
  React.useEffect(() => {
    refreshModelCatalog();
  }, [refreshModelCatalog]);

  const ctxValue = React.useMemo<AppContextValue>(
    () => ({ api, toast: showToast, refreshModelCatalog }),
    [api, showToast, refreshModelCatalog],
  );

  // ---- 主题 ----
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('omni-theme', theme);
    } catch {
      /* 忽略 */
    }
  }, [theme]);
  React.useEffect(() => {
    let t = 'dark';
    try {
      t = localStorage.getItem('omni-theme') || 'dark';
    } catch {
      /* 忽略 */
    }
    setTheme(t === 'light' ? 'light' : 'dark');

    // 恢复上次连接成功后的可用模型列表，避免刷新后下拉空白、又要去设置里点刷新。
    try {
      const cachedOptions = localStorage.getItem('omni-model-options');
      const cachedLabel = localStorage.getItem('omni-provider-label');
      if (cachedOptions) {
        const parsed = JSON.parse(cachedOptions) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) setModelOptions(parsed);
      }
      if (cachedLabel) setProviderLabel(cachedLabel);
      const cachedLeft = Number(localStorage.getItem('omni-left-width'));
      const cachedRight = Number(localStorage.getItem('omni-right-width'));
      if (cachedLeft >= 180 && cachedLeft <= 600) setLeftWidth(cachedLeft);
      if (cachedRight >= 180 && cachedRight <= 600) setRightWidth(cachedRight);
    } catch {
      /* 忽略 */
    }
  }, []);

  // ---- 适配器信息 + 当前配置（驱动 Composer 切换器） ----
  React.useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setAdapter((c.modelAdapter || 'mock') + (c.model ? ' · ' + c.model : ''));
        if (c.model) setModel(c.model);
        if (c.reasoning) setReasoning(c.reasoning);
        if (c.approval) setPermission(c.approval);
      })
      .catch(() => {});
  }, [api]);

  // ---- 事件流处理 ----
  const handleEvent = React.useCallback((ev: ThreadEvent) => {
    const p = ev.payload || {};
    if (ev.type === 'tool_call') {
      const callId = (p.callId as string) || ev.id;
      setLiveInputs((prev) => prev.filter((l) => l.id !== callId));
      setActiveTool((p.name as string) ?? null);
    }
    if (ev.type === 'assistant' || ev.type === 'reasoning') {
      setActiveTool(null);
    }
    setEvents((prev) => [...prev, ev]);
    if (ev.type === 'tool_result') {
      const callId = p.callId as string;
      if (callId) {
        const ok = p.ok === true;
        const text = p.error != null ? '✗ ' + String(p.error) : p.output != null ? String(p.output) : ok ? '✓ 成功' : '✗ 失败';
        setToolResults((prev) => ({ ...prev, [callId]: { text, ok } }));
      }
    }
  }, []);

  const updateToolInput = React.useCallback((params: Record<string, unknown>) => {
    const id = params.id as string;
    if (!id) return;
    setLiveInputs((prev) => {
      const exists = prev.find((l) => l.id === id);
      if (exists) return prev.map((l) => (l.id === id ? { ...l, partial: (params.partialJson as string) || '' } : l));
      return [...prev, { id, name: (params.name as string) || 'tool', partial: (params.partialJson as string) || '' }];
    });
  }, []);

  // ---- graph 运行态（SSE 驱动） ----
  const applyGraphProgress = React.useCallback((p: GraphProgress) => {
    if (!p || p.runId === undefined) return;
    setGraphRuns((prev) => {
      const run = prev[p.runId] || {
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
    });
  }, []);

  const applyGraphDone = React.useCallback((p: GraphDone) => {
    if (!p || p.runId === undefined) return;
    setGraphRuns((prev) => {
      const run = prev[p.runId];
      if (!run) return prev;
      return { ...prev, [p.runId]: { ...run, done: true, ok: p.ok, blackboard: p.blackboard, error: p.error } };
    });
  }, []);

  // ---- SSE 接线（仅挂载一次） ----
  React.useEffect(() => {
    stream.onOpen = () => setConnected(true);
    stream.onClose = () => setConnected(false);
    stream.onMessage = (msg: SseEnvelope) => {
      const params = msg.params as Record<string, unknown>;
      switch (msg.method) {
        case 'thread.event':
          handleEvent(params.event as ThreadEvent);
          break;
        case 'approval.request':
          setApproval(params as unknown as ApprovalRequest);
          break;
        case 'memory.changed':
          setMemoryReloadKey((k) => k + 1);
          break;
        case 'profile.applied':
        case 'profile.event':
          setProfilesReloadKey((k) => k + 1);
          break;
        case 'thread.tool_input':
          updateToolInput(params);
          break;
        case 'graph.progress':
          applyGraphProgress(params as unknown as GraphProgress);
          break;
        case 'graph.done':
          applyGraphDone(params as unknown as GraphDone);
          break;
      }
    };
    stream.connect();
    return () => stream.close();
  }, [stream, handleEvent, updateToolInput, applyGraphProgress, applyGraphDone]);

  // ---- graph 运行（含 SSE 不可用时的轮询回退） ----
  const pollRun = React.useCallback(
    (runId: string) => {
      let cancelled = false;
      const tick = async (i: number) => {
        if (cancelled || i >= 240) return;
        try {
          const st = await api.graphStatus(runId);
          setGraphRuns((prev) => {
            const run = prev[runId] || {
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
            return { ...prev, [runId]: { ...run, defName: st.defName, done: st.done, ok: st.ok, blackboard: st.blackboard, error: st.error, nodes: Array.from(nodes.values()) } };
          });
          if (st.done) return;
        } catch {
          /* 运行态尚未注册，继续 */
        }
        await new Promise((r) => setTimeout(r, 500));
        tick(i + 1);
      };
      tick(0);
    },
    [api],
  );

  const onRunStart = React.useCallback(
    (runId: string, name: string) => {
      setGraphRuns((prev) => ({
        ...prev,
        [runId]: { runId, defName: name, done: false, ok: undefined, nodes: [], blackboard: undefined, error: undefined },
      }));
      if (!stream.isOpen) pollRun(runId);
    },
    [stream, pollRun],
  );

  // ---- 会话列表刷新（磁盘存档，含各项目的工作区标记） ----
  const refreshSessions = React.useCallback(async () => {
    try {
      const r = await api.listSessions();
      const fromDisk: SessionEntry[] = r.sessions.map((s) => ({
        id: s.sessionId,
        label: s.label || s.sessionId,
        workspace: s.workspace,
        updatedAt: s.updatedAt,
        turns: s.turns,
      }));
      setSessions((prev) => {
        // 合并本进程在册但磁盘尚未保存的会话（每回合结束即落盘，此处兜底）。
        const ids = new Set(fromDisk.map((s) => s.id));
        return [...prev.filter((s) => !ids.has(s.id)), ...fromDisk];
      });
    } catch {
      /* 静默：列表不可用时保留内存态 */
    }
  }, [api]);
  React.useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // ---- 会话 / 发送 ----
  const send = React.useCallback(
    async (
      prompt: string,
      images: { url?: string; data?: string; mediaType?: string }[],
      files: import('../types/models.js').FileAttachment[],
    ) => {
      const params: {
        threadId?: string;
        prompt: string;
        images?: { url?: string; data?: string; mediaType?: string }[];
        files?: import('../types/models.js').FileAttachment[];
      } = currentThreadId ? { threadId: currentThreadId, prompt } : { prompt };
      if (images.length > 0) params.images = images;
      if (files.length > 0) params.files = files;
      setBusy(true);
      setActiveTool(null);
      try {
        const res = await api.runTurn(params);
        if (res.threadId) {
          setCurrentThreadId(res.threadId);
          setSessions((prev) => {
            if (prev.some((s) => s.id === res.threadId)) return prev;
            const next = [{ id: res.threadId, label: prompt || (files[0] ? '📎 ' + files[0].name : '') }, ...prev];
            return next;
          });
          void refreshSessions();
        }
      } catch (e) {
        const msg = (e as Error).message || '未知错误';
        // 错误不再弹窗阻断，而是写进对话流作为 system 提示 + toast，页面保持可用。
        showToast('运行失败：' + msg, 'err');
        setEvents((prev) => [
          ...prev,
          {
            id: 'err-' + Date.now().toString(36),
            type: 'system',
            timestamp: Date.now(),
            payload: { content: '运行失败：' + msg + '。可尝试切换模型或检查 API Key。' },
          },
        ]);
      } finally {
        setBusy(false);
        setActiveTool(null);
      }
    },
    [api, currentThreadId, refreshSessions],
  );

  // ---- Composer 切换器 ----
  const changeModel = React.useCallback(
    async (v: string) => {
      setModel(v);
      try {
        await api.updateConfig({ model: v });
      } catch (e) {
        showToast('切换模型失败：' + (e as Error).message, 'err');
      }
    },
    [api],
  );
  const changeReasoning = React.useCallback(
    async (v: string) => {
      setReasoning(v);
      try {
        await api.updateConfig({ reasoning: v });
      } catch (e) {
        window.alert('切换推理强度失败：' + (e as Error).message);
      }
    },
    [api],
  );
  const changePermission = React.useCallback(
    async (v: string) => {
      setPermission(v);
      try {
        await api.updateConfig({ approval: v });
      } catch (e) {
        window.alert('切换权限等级失败：' + (e as Error).message);
      }
    },
    [api],
  );

  const loadThread = React.useCallback(
    async (id: string) => {
      try {
        const r = await api.getThread(id);
        setCurrentThreadId(id);
        setEvents(r.items || []);
        setToolResults({});
        setLiveInputs([]);
        setSessions((prev) => prev.map((s) => s));
      } catch (e) {
        window.alert('加载会话失败：' + (e as Error).message);
      }
    },
    [api],
  );

  const newSession = React.useCallback(() => {
    setCurrentThreadId(null);
    setEvents([]);
    setToolResults({});
    setLiveInputs([]);
  }, []);

  const showDetail = React.useCallback((ev: ThreadEvent) => {
    setDetailEvent(ev);
    setActivePane('detail');
    if (window.innerWidth <= 880) {
      setLeftOpen(false);
      setRightOpen(false);
    }
  }, []);

  const respondApproval = React.useCallback(
    async (decision: 'allow' | 'deny', always: boolean) => {
      if (!approval) return;
      const req = approval;
      setApproval(null);
      try {
        if (always) {
          await api.updateConfig({ autoApprove: true });
          decision = 'allow';
        }
        await api.respondApproval(req.requestId, decision);
      } catch (e) {
        window.alert('审批响应失败：' + (e as Error).message);
      }
    },
    [approval, api],
  );

  const openFile = React.useCallback(
    async (path: string) => {
      try {
        const r = await api.readFs(path);
        const meta =
          (r.isBinary ? '二进制文件' : r.truncated ? '已截断（>200KB）' : '') + ' · ' + (r.size ?? 0) + ' 字节';
        setFileView({
          title: '📄 ' + r.path,
          meta: meta.trim(),
          content: r.isBinary ? '（二进制文件，无法预览）' : r.content || '',
        });
        setActivePane('file');
        setRightOpen(true);
      } catch (e) {
        window.alert('打开失败：' + (e as Error).message);
      }
    },
    [api],
  );

  const closeDrawers = React.useCallback(() => {
    setLeftOpen(false);
    setRightOpen(false);
  }, []);
  const toggleLeft = React.useCallback(() => {
    setLeftOpen((o) => !o);
    setRightOpen(false);
  }, []);
  const toggleRight = React.useCallback(() => {
    setRightOpen((o) => !o);
    setLeftOpen(false);
  }, []);
  const toggleTheme = React.useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), []);

  const toolItems: ToolItem[] = React.useMemo(() => {
    const items: ToolItem[] = [];
    for (const e of events) {
      if (e.type !== 'tool_call') continue;
      const p = e.payload || {};
      const callId = (p.callId as string) || e.id;
      const res = toolResults[callId];
      items.push({ callId, name: (p.name as string) || 'tool', status: res ? (res.ok ? 'ok' : 'err') : 'pending' });
    }
    return items;
  }, [events, toolResults]);

  const onShowTool = React.useCallback(
    (callId: string) => {
      const ev = events.find((e) => {
        if (e.type !== 'tool_call') return false;
        const p = e.payload || {};
        return ((p.callId as string) || e.id) === callId;
      });
      if (ev) showDetail(ev);
    },
    [events, showDetail],
  );

  let pane: ReactElement;
  switch (activePane) {
    case 'metrics':
      pane = html`<${MetricsTab} />`;
      break;
    case 'changes':
      pane = html`<${ChangesTab} />`;
      break;
    case 'settings':
      pane = html`<${SettingsTab} theme=${theme} onToggleTheme=${toggleTheme} />`;
      break;
    case 'plugins':
      pane = html`<${PluginsTab} />`;
      break;
    case 'graph':
      pane = html`<${GraphTab} graphRuns=${graphRuns} onRunStart=${onRunStart} />`;
      break;
    case 'memory':
      pane = html`<${MemoryTab} reloadKey=${memoryReloadKey} />`;
      break;
    case 'profiles':
      pane = html`<${ProfilesTab} reloadKey=${profilesReloadKey} />`;
      break;
    case 'file':
      pane = html`<${FileTab} fileView=${fileView} />`;
      break;
    case 'detail':
      pane = html`<${DetailTab} detailEvent=${detailEvent} />`;
      break;
    case 'tools':
    default:
      pane = html`<${ToolsTab} toolItems=${toolItems} onShowTool=${onShowTool} />`;
      break;
  }

  return html`<${AppContext.Provider} value=${ctxValue}>
    <div className="app">
      <${TopBar}
        connected=${connected}
        adapter=${adapter}
        onToggleTheme=${toggleTheme}
        onToggleLeft=${toggleLeft}
        onToggleRight=${toggleRight}
      />
      <div className="body">
        <${NavRail} activePane=${activePane} onSelect=${setActivePane} />
        <${SessionPanel}
          sessions=${sessions}
          currentThreadId=${currentThreadId}
          onSelect=${loadThread}
          onNew=${newSession}
          onOpenFile=${openFile}
          onWorkspaceSwitched=${() => void refreshSessions()}
          open=${leftOpen}
          style=${{ width: leftWidth + 'px' }}
        />
        <${Resizer}
          side="left"
          width=${leftWidth}
          onChange=${(w: number) => {
            setLeftWidth(w);
            try { localStorage.setItem('omni-left-width', String(w)); } catch { /* 忽略 */ }
          }}
        />
        <${StreamView}
          events=${events}
          toolResults=${toolResults}
          liveInputs=${liveInputs}
          onEventClick=${showDetail}
          onOpenFile=${openFile}
          onSend=${send}
          busy=${busy}
          activeTool=${activeTool}
          model=${model}
          modelOptions=${modelOptions}
          providerLabel=${providerLabel}
          reasoning=${reasoning}
          reasoningOptions=${reasoningOptions}
          permission=${permission}
          onModelChange=${changeModel}
          onReasoningChange=${changeReasoning}
          onPermissionChange=${changePermission}
          api=${api}
        />
        <${Resizer}
          side="right"
          width=${rightWidth}
          onChange=${(w: number) => {
            setRightWidth(w);
            try { localStorage.setItem('omni-right-width', String(w)); } catch { /* 忽略 */ }
          }}
        />
        <${RightPanel} activePane=${activePane} onSelect=${setActivePane} open=${rightOpen} style=${{ width: rightWidth + 'px' }}>
          ${pane}
        <//>
      </div>
      <${ApprovalModal} approval=${approval} onRespond=${respondApproval} />
      <div className=${'drawer-backdrop' + (leftOpen || rightOpen ? ' show' : '')} onClick=${closeDrawers}></div>
      <${Toast} toast=${toastState} />
    </div>
  <//>`;
}

// 挂载入口（由 main.ts 调用，便于独立测试）。
export function mountApp(container: Element): void {
  ReactDOM.createRoot(container).render(html`<${App} />`);
}
