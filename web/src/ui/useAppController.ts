// 应用根组件的「容器」层（C3 拆分）：集中持有全部状态、副作用与回调，
// 供纯视图 App 消费。所有纯状态变换委托给 ./appReducers.js；
// 本文件只负责 React 生命周期接线——组件挂载、SSE 流、localStorage 恢复、
// 命令面板快捷键、各业务回调。行为与旧版 App() 内联实现逐字节等价。

import { React } from './deps.js';
import { ApiClient } from '../core/ApiClient.js';
import { EventStream } from '../core/EventStream.js';
import { ToastService } from '../core/ToastService.js';
import type { ToastKind } from '../core/ToastService.js';
import type { AppContextValue } from './context.js';
import type {
  ApprovalRequest,
  FileAttachment,
  GraphDone,
  GraphProgress,
  GraphRunState,
  SseEnvelope,
  ThreadEvent,
} from '../types/models.js';
import type { CommandItem } from './components/CommandPalette.js';
import type { FileView, LiveInput, SessionEntry, ToastState, ToolItem } from './shared.js';
import type { ToolResultView } from './components/StreamView.js';
import { langOf } from './highlight.js';
import {
  appendEvent,
  applyGraphDone,
  applyGraphProgress,
  applyGraphStatus,
  appendFinalText,
  buildCommands,
  buildGraphRunInitial,
  buildToolItems,
  mergeSessions,
  mergeToolInput,
  mergeToolResult,
} from './appReducers.js';

/** useAppController 的返回：纯视图 App 渲染所需的全部状态与回调。 */
export interface AppController {
  api: ApiClient;
  connected: boolean;
  adapter: string;
  activePane: string;
  model: string;
  modelOptions: string[];
  providerLabel: string;
  reasoning: string;
  reasoningOptions: string[] | undefined;
  permission: string;
  events: ThreadEvent[];
  toolResults: Record<string, ToolResultView>;
  liveInputs: LiveInput[];
  sessions: SessionEntry[];
  currentThreadId: string | null;
  detailEvent: ThreadEvent | null;
  approval: ApprovalRequest | null;
  fileView: FileView | null;
  theme: 'dark' | 'light';
  leftOpen: boolean;
  rightOpen: boolean;
  memoryReloadKey: number;
  profilesReloadKey: number;
  graphRuns: Record<string, GraphRunState>;
  busy: boolean;
  activeTool: string | null;
  toastState: ToastState;
  paletteOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  toolItems: ToolItem[];
  commands: CommandItem[];
  ctxValue: AppContextValue;
  // 回调
  showToast: (message: string, kind?: ToastKind) => void;
  refreshModelCatalog: () => void;
  handleEvent: (ev: ThreadEvent) => void;
  updateToolInput: (params: Record<string, unknown>) => void;
  onShowTool: (callId: string) => void;
  onRunStart: (runId: string, name: string) => void;
  refreshSessions: () => Promise<void>;
  send: (
    prompt: string,
    images: { url?: string; data?: string; mediaType?: string }[],
    files: FileAttachment[],
  ) => Promise<void>;
  changeModel: (v: string) => Promise<void>;
  changeReasoning: (v: string) => Promise<void>;
  changePermission: (v: string) => Promise<void>;
  loadThread: (id: string) => Promise<void>;
  newSession: () => void;
  showDetail: (ev: ThreadEvent) => void;
  respondApproval: (decision: 'allow' | 'deny', always: boolean) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeDrawers: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleTheme: () => void;
  openPane: (key: string) => void;
  onLeftWidthChange: (w: number) => void;
  onRightWidthChange: (w: number) => void;
  openPalette: () => void;
  closePalette: () => void;
  refreshSessionsVoid: () => void;
  openSettingsPane: () => void;
  // 状态 setter（纯视图需要直接驱动的部分）
  setActivePane: (key: string) => void;
}

/**
 * 应用根状态容器：装配 OO 服务层（ApiClient / EventStream / ToastService）、
 * 路由 SSE 消息到共享状态、维护三栏布局与移动端抽屉、主题与 toast。
 * @returns 纯视图 App 渲染所需的全部状态与回调。
 */
export function useAppController(): AppController {
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
  /** 命令面板（Cmd/Ctrl+P / K 唤起）开关。 */
  const [paletteOpen, setPaletteOpen] = React.useState(false);
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

  // ---- 命令面板快捷键：Ctrl/Cmd+P 或 Ctrl/Cmd+K 唤起 / 关闭（对标 Codex / 现代编辑器） ----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'k')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
    setEvents((prev) => appendEvent(prev, ev));
    if (ev.type === 'tool_result') {
      const callId = p.callId as string;
      if (callId) {
        setToolResults((prev) => mergeToolResult(prev, callId, p));
      }
    }
  }, []);

  const updateToolInput = React.useCallback((params: Record<string, unknown>) => {
    setLiveInputs((prev) => mergeToolInput(prev, params));
  }, []);

  // ---- graph 运行态（SSE 驱动） ----
  const applyGraphProgressCb = React.useCallback((p: GraphProgress) => {
    setGraphRuns((prev) => applyGraphProgress(prev, p));
  }, []);

  const applyGraphDoneCb = React.useCallback((p: GraphDone) => {
    setGraphRuns((prev) => applyGraphDone(prev, p));
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
          applyGraphProgressCb(params as unknown as GraphProgress);
          break;
        case 'graph.done':
          applyGraphDoneCb(params as unknown as GraphDone);
          break;
      }
    };
    stream.connect();
    return () => stream.close();
  }, [stream, handleEvent, updateToolInput, applyGraphProgressCb, applyGraphDoneCb]);

  // ---- graph 运行（含 SSE 不可用时的轮询回退） ----
  const pollRun = React.useCallback(
    (runId: string) => {
      const cancelled = false;
      const tick = async (i: number) => {
        if (cancelled || i >= 240) return;
        try {
          const st = await api.graphStatus(runId);
          setGraphRuns((prev) => applyGraphStatus(prev, runId, st));
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
      setGraphRuns((prev) => ({ ...prev, [runId]: buildGraphRunInitial(runId, name) }));
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
        running: s.running === true,
      }));
      setSessions((prev) => mergeSessions(prev, fromDisk));
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
      files: FileAttachment[],
    ) => {
      const params: {
        threadId?: string;
        prompt: string;
        images?: { url?: string; data?: string; mediaType?: string }[];
        files?: FileAttachment[];
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
        // 兜底：若后端最后一步未产出 assistant 事件（如以 tool/empty 收尾），对话流末尾只余过程事件，
        // 用户看不到最终总结。此时把 RPC 返回的 finalText 补成一条 assistant 事件渲染到流尾。
        // 若流中已存在同内容 assistant 事件（SSE 已推送），则跳过避免重复。
        setEvents((prev) => appendFinalText(prev, res.finalText));
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
        showToast('切换推理强度失败：' + (e as Error).message, 'err');
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
        showToast('切换权限等级失败：' + (e as Error).message, 'err');
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
        // #OBS-12：加载历史会话或新建时必须把 busy 重置为 false。
        // 否则上轮发送中刷新 / SSE 中断 / 切到别的会话后，busy 卡在 true，
        // 会把已结束回合的 process-cluster 错误地持续展开——结果被过程挤下去。
        // activeTool 同样：残留的"运行中"状态会和"换会话/刷新"语义不符。
        setBusy(false);
        setActiveTool(null);
        setSessions((prev) => prev.map((s) => s));
      } catch (e) {
        showToast('加载会话失败：' + (e as Error).message, 'err');
      }
    },
    [api],
  );

  const newSession = React.useCallback(() => {
    setCurrentThreadId(null);
    setEvents([]);
    setToolResults({});
    setLiveInputs([]);
    // #OBS-12：新建会话同样把 busy 清零——避免"前一会话未结束的 busy"继续撑开历史 cluster。
    setBusy(false);
    setActiveTool(null);
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
        showToast('审批响应失败：' + (e as Error).message, 'err');
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
          // 依据路径推断语言做语法高亮；二进制不参与。
          lang: r.isBinary ? '' : langOf(r.path),
        });
        setActivePane('file');
        setRightOpen(true);
      } catch (e) {
        showToast('打开失败：' + (e as Error).message, 'err');
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

  /** 打开右侧某面板（AddMenu 点插件等场景复用）。 */
  const openPane = React.useCallback(
    (key: string) => {
      setActivePane(key);
      setRightOpen(true);
    },
    [],
  );

  /** 左/右侧面板宽度变更：memoized 避免 Resizer 拖拽时因父级重渲染导致 effect 反复卸载/重挂。 */
  const onLeftWidthChange = React.useCallback((w: number) => {
    setLeftWidth(w);
    try {
      localStorage.setItem('omni-left-width', String(w));
    } catch {
      /* 忽略 */
    }
  }, []);
  const onRightWidthChange = React.useCallback((w: number) => {
    setRightWidth(w);
    try {
      localStorage.setItem('omni-right-width', String(w));
    } catch {
      /* 忽略 */
    }
  }, []);

  const openPalette = React.useCallback(() => setPaletteOpen(true), []);
  const closePalette = React.useCallback(() => setPaletteOpen(false), []);
  const refreshSessionsVoid = React.useCallback(() => void refreshSessions(), [refreshSessions]);
  const openSettingsPane = React.useCallback(() => openPane('settings'), [openPane]);

  const toolItems: ToolItem[] = React.useMemo(
    () => buildToolItems(events, toolResults),
    [events, toolResults],
  );

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

  // ---- 命令面板命令集（切换面板 / 会话 / 界面） ----
  const commands = React.useMemo<CommandItem[]>(
    () =>
      buildCommands({
        setActivePane,
        setRightOpen,
        newSession,
        refreshSessions,
        toggleTheme,
        toggleLeft,
        toggleRight,
      }),
    [newSession, refreshSessions, toggleTheme, toggleLeft, toggleRight, setActivePane, setRightOpen],
  );

  return {
    api,
    connected,
    adapter,
    activePane,
    model,
    modelOptions,
    providerLabel,
    reasoning,
    reasoningOptions,
    permission,
    events,
    toolResults,
    liveInputs,
    sessions,
    currentThreadId,
    detailEvent,
    approval,
    fileView,
    theme,
    leftOpen,
    rightOpen,
    memoryReloadKey,
    profilesReloadKey,
    graphRuns,
    busy,
    activeTool,
    toastState,
    paletteOpen,
    leftWidth,
    rightWidth,
    toolItems,
    commands,
    ctxValue,
    showToast,
    refreshModelCatalog,
    handleEvent,
    updateToolInput,
    onShowTool,
    onRunStart,
    refreshSessions,
    send,
    changeModel,
    changeReasoning,
    changePermission,
    loadThread,
    newSession,
    showDetail,
    respondApproval,
    openFile,
    closeDrawers,
    toggleLeft,
    toggleRight,
    toggleTheme,
    openPane,
    onLeftWidthChange,
    onRightWidthChange,
    openPalette,
    closePalette,
    refreshSessionsVoid,
    openSettingsPane,
    setActivePane,
  };
}
