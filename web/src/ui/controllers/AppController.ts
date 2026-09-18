// 应用根组件的「容器」层（C3 拆分，标准 class 方式）：集中持有全部状态、副作用与回调，
// 供纯视图 App（class 组件）消费。本类为门面 / 组合根——装配 OO 服务层
// （ApiClient / EventStream / ToastService / AppReducers），按职责拆出子控制器
// （SessionController / ComposerController / GraphController），自身只负责生命周期接线、
// SSE 路由、主题 / 面板 / 抽屉 / 布局 / 审批、context value 与命令集。
// 行为与旧版 useAppController 内联实现逐字节等价。

import { ApiClient } from '../../core/ApiClient.js';
import { EventStream } from '../../core/EventStream.js';
import { ToastService } from '../../core/ToastService.js';
import type { ToastKind } from '../../core/ToastService.js';
import { DialogService } from '../../core/DialogService.js';
import type { DialogState } from '../../core/DialogService.js';
import type { AppContextValue } from '../context.js';
import type {
  ApprovalRequest,
  GraphDone,
  GraphProgress,
  GraphRunState,
  SseEnvelope,
  ThreadEvent,
} from '../../types/models.js';
import type { CommandItem } from '../components/CommandPalette.js';
import { KeyboardShortcuts } from '../models/KeyboardShortcuts.js';
import type { FileView, LiveInput, SessionEntry, ToolResultView, ToastState } from '../shared.js';
import { AppReducers } from './AppReducers.js';
import { formatProfilePluginToast } from '../notify.js';
import { SessionController } from './SessionController.js';
import { ComposerController } from './ComposerController.js';
import { GraphController } from './GraphController.js';
import { ShortcutActions } from './ShortcutActions.js';

/** 应用根组件的全部 UI 状态（原 useAppController 的各 useState 合集）。 */
export interface AppState {
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
  /** 应用内对话框状态（替代 window.confirm / window.prompt）。 */
  dialog: DialogState;
  /** 本回合已累积的流式正文（`thread.text_delta` 增量拼接）。 */
  streamText: string;
  /** 已被 assistant 事件收口的流式文本（用于避免最终卡片重复播渐进揭示动画）。 */
  finalizedStreamText: string;
  leftWidth: number;
  rightWidth: number;
}

/** 视图（App class 组件）向控制器暴露的状态写入接口。 */
export interface AppHost {
  /** 以局部补丁或函数式 updater 更新状态（等价 React setState）。 */
  patch(state: Partial<AppState> | ((prev: AppState) => Partial<AppState>)): void;
  /** 读取当前完整状态（供控制器同步读取 currentThreadId / approval 等）。 */
  getState(): AppState;
}

/** 控制器共享的服务与纯归约器集合（组合根注入）。 */
export interface AppServices {
  api: ApiClient;
  stream: EventStream;
  toastSvc: ToastService;
  /** 应用内对话框服务（confirm / prompt）。 */
  dialogSvc: DialogService;
  reducers: AppReducers;
  /** 统一 toast 出口（AppController.showToast 的引用，供子控制器调用）。 */
  toast: (message: string, kind?: ToastKind) => void;
}

/** 应用根状态容器：门面 + 组合根，驱动 App 的渲染所需全部状态与回调。 */
export class AppController {
  /** 状态宿主（App class 组件）。 */
  private readonly host: AppHost;
  /** 共享服务与纯归约器集合（组合根注入）。 */
  private readonly services: AppServices;
  /** 按职责拆出的子控制器与协作件（会话 / 输入框 / graph / 快捷键解析与执行）。 */
  private readonly children: {
    sessions: SessionController;
    composer: ComposerController;
    graph: GraphController;
    /** 全局快捷键解析器（无状态）。 */
    keyBindings: KeyboardShortcuts;
    /** 快捷键动作执行器（回调由组合根注入）。 */
    shortcuts: ShortcutActions;
  };
  /** 命令面板命令集（构造时一次性计算）。 */
  public commands: CommandItem[];
  /** 全局快捷键监听句柄（卸载时移除）。 */
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  /** 会话子控制器（只读暴露给视图层）。 */
  public get sessions(): SessionController {
    return this.children.sessions;
  }

  /** 输入框 / 发送子控制器（只读暴露给视图层）。 */
  public get composer(): ComposerController {
    return this.children.composer;
  }

  /** graph 运行态子控制器（只读暴露给视图层）。 */
  public get graph(): GraphController {
    return this.children.graph;
  }

  /** 共享 API 客户端（供 StreamView 等直接调用）。 */
  public get api(): ApiClient {
    return this.services.api;
  }

  /**
   * 装配服务层与子控制器。
   * @param host 视图（App class 组件）实现的状态宿主
   */
  public constructor(host: AppHost) {
    this.host = host;
    this.services = {
      api: new ApiClient(),
      stream: new EventStream(),
      toastSvc: new ToastService(),
      dialogSvc: new DialogService(),
      reducers: new AppReducers(),
      toast: (message: string, kind?: ToastKind) => this.showToast(message, kind),
    };
    const sessions = new SessionController(this.host, this.services);
    const graph = new GraphController(this.host, this.services);
    const composer = new ComposerController(this.host, this.services, sessions);
    this.children = {
      sessions,
      composer,
      graph,
      keyBindings: new KeyboardShortcuts(),
      shortcuts: new ShortcutActions({
        togglePalette: () => this.host.patch((s) => ({ paletteOpen: !s.paletteOpen })),
        newSession: () => sessions.newSession(),
        toggleLeft: () => this.toggleLeft(),
        toggleRight: () => this.toggleRight(),
        toggleTheme: () => this.toggleTheme(),
      }),
    };
    this.commands = this.buildCommands();
    // 绑定对外回调，保证作为 props 传递给子组件时 this 正确。
    this.setActivePane = this.setActivePane.bind(this);
    this.toggleTheme = this.toggleTheme.bind(this);
    this.toggleLeft = this.toggleLeft.bind(this);
    this.toggleRight = this.toggleRight.bind(this);
    this.openPane = this.openPane.bind(this);
    this.openSettingsPane = this.openSettingsPane.bind(this);
    this.openPalette = this.openPalette.bind(this);
    this.closePalette = this.closePalette.bind(this);
    this.onLeftWidthChange = this.onLeftWidthChange.bind(this);
    this.onRightWidthChange = this.onRightWidthChange.bind(this);
    this.respondApproval = this.respondApproval.bind(this);
    this.showToast = this.showToast.bind(this);
  }

  /** 挂载：绑定 toast / 对话框服务、拉取目录/配置、初始化主题、连接 SSE、刷新会话。 @returns 无 */
  public mount(): void {
    this.services.toastSvc.bind((message: string, kind?: ToastKind) => this.showToast(message, kind));
    this.services.dialogSvc.bind((state: DialogState) => this.host.patch({ dialog: state }));
    this.refreshModelCatalog();
    this.initTheme();
    this.services.api
      .getConfig()
      .then((c) => {
        this.host.patch((s) => ({
          adapter: (c.modelAdapter || 'mock') + (c.model ? ' · ' + c.model : ''),
          model: c.model ? c.model : s.model,
          reasoning: c.reasoning ? c.reasoning : s.reasoning,
          permission: c.approval ? c.approval : s.permission,
        }));
      })
      .catch(() => {});
    this.connectStream();
    void this.children.sessions.refreshSessions();
  }

  /** 卸载：关闭 SSE 流并移除全局快捷键监听。 @returns 无 */
  public unmount(): void {
    this.services.stream.close();
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
  }

  /** 连接 SSE 并把各消息方法路由到对应子控制器。 @returns 无 */
  public connectStream(): void {
    const stream = this.services.stream;
    stream.onOpen = () => this.host.patch({ connected: true });
    stream.onClose = () => this.host.patch({ connected: false });
    stream.onMessage = (msg: SseEnvelope) => {
      const params = msg.params as Record<string, unknown>;
      switch (msg.method) {
        case 'thread.event':
          this.children.sessions.handleEvent(params.event as ThreadEvent);
          break;
        case 'approval.request':
          this.host.patch({ approval: params as unknown as ApprovalRequest });
          break;
        case 'memory.changed':
          this.host.patch((s) => ({ memoryReloadKey: s.memoryReloadKey + 1 }));
          break;
        case 'profile.event':
          this.host.patch((s) => ({ profilesReloadKey: s.profilesReloadKey + 1 }));
          break;
        case 'profile.applied':
          this.host.patch((s) => ({ profilesReloadKey: s.profilesReloadKey + 1 }));
          this.applyProfilePluginToast('profile.applied', params);
          break;
        case 'profile.error':
        case 'plugin.loaded':
        case 'plugin.loadError':
          this.applyProfilePluginToast(msg.method, params);
          break;
        case 'thread.tool_input':
          this.children.sessions.updateToolInput(params);
          break;
        case 'thread.text_delta':
          this.children.sessions.appendTextDelta(params);
          break;
        case 'graph.progress':
          this.children.graph.applyGraphProgress(params as unknown as GraphProgress);
          break;
        case 'graph.done':
          this.children.graph.applyGraphDone(params as unknown as GraphDone);
          break;
      }
    };
    stream.connect();
    this.keyHandler = (e: KeyboardEvent) => {
      const action = this.children.keyBindings.resolve(e);
      if (!action) return;
      e.preventDefault();
      this.children.shortcuts.run(action);
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  /** 拉取当前厂商可用模型清单并写入状态 / 持久化（含推理强度档位）。 @returns 无 */
  public refreshModelCatalog(): void {
    this.services.api
      .modelCatalog()
      .then((cat) => {
        const active = cat.active;
        if (active) {
          this.host.patch({
            modelOptions: active.models,
            providerLabel: active.label,
            reasoningOptions: active.reasoningEffort,
          });
          try {
            localStorage.setItem('omni-model-options', JSON.stringify(active.models));
            localStorage.setItem('omni-provider-label', active.label);
          } catch {
            /* 忽略 */
          }
          this.host.patch((s) => (s.model ? s : { model: active.model || s.model }));
        }
      })
      .catch(() => {});
  }

  /** 从 localStorage 恢复主题 / 模型清单 / 面板宽度（挂载时调用一次）。 @returns 无 */
  public initTheme(): void {
    let theme: 'dark' | 'light' = 'dark';
    try {
      theme = (localStorage.getItem('omni-theme') || 'dark') === 'light' ? 'light' : 'dark';
    } catch {
      /* 忽略 */
    }
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('omni-theme', theme);
    } catch {
      /* 忽略 */
    }
    this.host.patch({ theme });
    try {
      const cachedOptions = localStorage.getItem('omni-model-options');
      const cachedLabel = localStorage.getItem('omni-provider-label');
      if (cachedOptions) {
        const parsed = JSON.parse(cachedOptions) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) this.host.patch({ modelOptions: parsed });
      }
      if (cachedLabel) this.host.patch({ providerLabel: cachedLabel });
      const cachedLeft = Number(localStorage.getItem('omni-left-width'));
      const cachedRight = Number(localStorage.getItem('omni-right-width'));
      if (cachedLeft >= 180 && cachedLeft <= 600) this.host.patch({ leftWidth: cachedLeft });
      if (cachedRight >= 180 && cachedRight <= 600) this.host.patch({ rightWidth: cachedRight });
    } catch {
      /* 忽略 */
    }
  }

  /** 切换浅色 / 深色主题（同步写 document 属性与 localStorage）。 @returns 无 */
  public toggleTheme(): void {
    const next: 'dark' | 'light' = this.host.getState().theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('omni-theme', next);
    } catch {
      /* 忽略 */
    }
    this.host.patch({ theme: next });
  }

  /** 切换左侧会话面板（互斥关闭右侧）。 @returns 无 */
  public toggleLeft(): void {
    this.host.patch((s) => ({ leftOpen: !s.leftOpen, rightOpen: false }));
  }

  /** 切换右侧工具面板（互斥关闭左侧）。 @returns 无 */
  public toggleRight(): void {
    this.host.patch((s) => ({ rightOpen: !s.rightOpen, leftOpen: false }));
  }

  /**
   * 打开右侧某面板。
   * @param key 面板标识
   * @returns 无
   */
  public openPane(key: string): void {
    this.host.patch({ activePane: key, rightOpen: true });
  }

  /** 打开「设置」面板（审批弹窗「修改权限」复用）。 @returns 无 */
  public openSettingsPane(): void {
    this.openPane('settings');
  }

  /** 打开命令面板。 @returns 无 */
  public openPalette(): void {
    this.host.patch({ paletteOpen: true });
  }

  /** 关闭命令面板。 @returns 无 */
  public closePalette(): void {
    this.host.patch({ paletteOpen: false });
  }

  /**
   * 左/右侧面板拖拽宽度变更（持久化到 localStorage）。
   * @param w 宽度
   * @returns 无
   */
  public onLeftWidthChange(w: number): void {
    this.host.patch({ leftWidth: w });
    try {
      localStorage.setItem('omni-left-width', String(w));
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 右/左侧面板拖拽宽度变更（持久化到 localStorage）。
   * @param w 宽度
   * @returns 无
   */
  public onRightWidthChange(w: number): void {
    this.host.patch({ rightWidth: w });
    try {
      localStorage.setItem('omni-right-width', String(w));
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 响应审批（允许 / 拒绝），可选「总是允许」时写回 autoApprove。
   * @param decision 决策
   * @param always 是否记忆为始终允许
   * @returns 异步完成
   */
  public async respondApproval(decision: 'allow' | 'deny', always: boolean): Promise<void> {
    const req = this.host.getState().approval;
    if (!req) return;
    this.host.patch({ approval: null });
    try {
      if (always) {
        await this.services.api.updateConfig({ autoApprove: true });
        decision = 'allow';
      }
      await this.services.api.respondApproval(req.requestId, decision);
    } catch (e) {
      this.services.toast('审批响应失败：' + (e as Error).message, 'err');
    }
  }

  /**
   * 设置当前激活面板（NavRail / RightPanel 复用）。
   * @param key 面板标识
   * @returns 无
   */
  public setActivePane(key: string): void {
    this.host.patch({ activePane: key });
  }

  /**
   * 弹出轻提示（成功 / 错误等），2.2s 后自动隐藏。
   * @param message 提示文案
   * @param kind 提示级别
   * @returns 无
   */
  public showToast(message: string, kind: ToastKind = 'info'): void {
    this.host.patch({ toastState: { message, kind, visible: true } });
    window.setTimeout(
      () => this.host.patch((s) => (s.toastState.message === message ? { ...s, toastState: { ...s.toastState, visible: false } } : {})),
      2200,
    );
  }

  /**
   * 把后端推送的「插件集 / 插件加载」类通知落为实时轻提示（toast）。
   * 这些事件原先在 SSE 流里被静默丢弃（profile.error / plugin.loaded / plugin.loadError）
   * 或仅触发静默刷新（profile.applied），补齐 UI 对加载成败的可见反馈。
   * @param method 通知方法名。
   * @param params 通知参数。
   * @returns 无
   */
  private applyProfilePluginToast(method: string, params: Record<string, unknown>): void {
    const toast = formatProfilePluginToast(method, params);
    if (toast !== null) this.showToast(toast.message, toast.kind);
  }

  /** 构造注入 AppContext.Provider 的上下文值（api / toast / dialog / refreshModelCatalog）。 @returns 上下文值 */
  public getContextValue(): AppContextValue {
    return {
      api: this.services.api,
      toast: (message: string, kind?: ToastKind) => this.showToast(message, kind),
      dialog: this.services.dialogSvc,
      refreshModelCatalog: () => this.refreshModelCatalog(),
    };
  }

  /** 预计算命令面板命令集。 @returns 命令集 */
  private buildCommands(): CommandItem[] {
    return this.services.reducers.buildCommands({
      setActivePane: (key: string) => this.setActivePane(key),
      setRightOpen: (open: boolean) => this.host.patch({ rightOpen: open }),
      newSession: () => this.children.sessions.newSession(),
      refreshSessions: () => void this.children.sessions.refreshSessions(),
      toggleTheme: () => this.toggleTheme(),
      toggleLeft: () => this.toggleLeft(),
      toggleRight: () => this.toggleRight(),
    });
  }
}
