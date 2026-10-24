// 应用根组件的「容器」层（C3 拆分，标准 class 方式）：集中持有全部状态、副作用与回调，
// 供纯视图 App（class 组件）消费。本类为门面 / 组合根——装配 OO 服务层
// （ApiClient / EventStream / ToastService / AppReducers），按职责拆出子控制器
// （SessionController / ComposerController / GraphController），自身只负责生命周期接线、
// SSE 路由、主题 / 面板 / 抽屉 / 布局 / 审批、context value 与命令集。
// 行为与旧版 useAppController 内联实现逐字节等价。

import { ApiClient } from '../../core/ApiClient.ts';
import type { AppRoute } from '../../core/Router.ts';
import { EventStream } from '../../core/EventStream.ts';
import { RouteBinding } from './RouteBinding.ts';
import { LayoutController } from './LayoutController.ts';
import { MethodBinder } from './methodBinder.ts';
import { ToastService } from '../../core/ToastService.ts';
import type { ToastKind } from '../../core/ToastService.ts';
import { DialogService } from '../../core/DialogService.ts';
import type { DialogState } from '../../core/DialogService.ts';
import type { AppContextValue } from '../context.ts';
import type {
  ApprovalRequest,
  GraphDone,
  GraphProgress,
  GraphRunState,
  QuestionAnswerSubmission,
  QuestionRequest,
  SseEnvelope,
  ThreadEvent,
} from '../../types/models.ts';
import type { CommandItem } from '../components/CommandPalette.tsx';
import type { SettingsTabKey } from '../models/SettingsModel.ts';
import type { ThemePreference } from '../models/ThemePreference.ts';
import type { Locale } from '../i18n/i18n.ts';
import { KeyboardShortcuts } from '../models/KeyboardShortcuts.ts';
import type { BrowserView, FileView, LiveInput, SessionEntry, ToolResultView, ToastState } from '../shared.ts';
import type { ComposerSeed } from '../shared.ts';
import { AppReducers } from './AppReducers.ts';
import { formatProfilePluginToast } from '../notify.ts';
import { desktopBridge, notifyDesktop } from '../../core/desktop/DesktopBridge.ts';
import { SessionController } from './SessionController.ts';
import { ComposerController } from './ComposerController.ts';
import { GraphController } from './GraphController.ts';
import { FileController } from './FileController.ts';
import { BrowserController } from './BrowserController.ts';
import { SettingsController } from './SettingsController.ts';
import { ShortcutActions } from './ShortcutActions.ts';
import { t } from '../i18n/i18n.ts';

/** 应用根组件的全部 UI 状态（原 useAppController 的各 useState 合集）。 */
export interface AppState {
  /** SSE 是否已连接（`streamState === 'open'`；历史消费者只认这个布尔量）。 */
  connected: boolean;
  /**
   * SSE 连接三态（驱动顶栏徽标文案与配色）。
   *
   * `connecting` 覆盖「首次连接中」与「断线自动重连中」——两者都不该显示成红色的「断开」。
   */
  streamState: 'open' | 'connecting' | 'closed';
  adapter: string;
  activePane: string;
  /** 设置模态是否打开（2026-10-17：设置从右栏面板改为模态）。 */
  settingsOpen: boolean;
  /** 功能面板模态是否打开（2026-10-19：面板从右栏下拉改为设置式左导航模态）。 */
  panelModalOpen: boolean;
  /** 设置模态当前分栏（打开时定位，关闭后保留上次选择）。 */
  settingsTab: SettingsTabKey;
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
  /**
   * 会话数据版本号：切换会话或回合推进（tool_result / assistant / turn.end 等）后 +1。
   *
   * 为什么单独一个计数：面板（指标 / 审计 / 治理 / 回滚 / 记忆…）各自在 effect 里拉数据，
   * 它们需要「当前会话 + 本回合有新数据」作为重新拉取的信号。直接依赖 events 数组会让
   * 每个 token 增量都触发全部面板重拉（请求风暴）；这里按 300ms 去抖，只表达「数据可能变了」。
   */
  sessionTick: number;
  detailEvent: ThreadEvent | null;
  approval: ApprovalRequest | null;
  /**
   * 待作答的提问（服务端 `question.request` 上行；null 表示当前没有）。
   *
   * 与 `approval` 同构：都是「服务端停下来等人回答」的状态，只是提问要收的是结构化作答。
   */
  question: QuestionRequest | null;
  fileView: FileView | null;
  /**
   * 代码查看器已打开的文件标签集合（`openFile` 追加、`closeOpenFile` 移除；
   * 合并 / 关闭规则见 `models/FileTabs.ts`）。`fileView` 永远指向其中激活的一个（或 null）。
   */
  openFiles: FileView[];
  /** 右栏「网页」标签状态（内置浏览器：地址 / 重载 / 失败原因）。 */
  browser: BrowserView;
  /** 解析后的实际主题（落在 `<html data-theme>` 上的值）。 */
  theme: 'dark' | 'light';
  /**
   * 主题偏好（`system` / `dark` / `light`）。
   *
   * 与 `theme` 分开：`theme` 是"现在渲染成什么"，偏好是"用户希望怎么决定"。
   * 偏好为 `system` 时 `theme` 会随系统主题实时变化（见 LayoutController.watchSystem）。
   */
  themePref: ThemePreference;
  /** 界面语言（zh=中文 / en=English；本机偏好恢复与切换见 LayoutController / i18n）。 */
  locale: Locale;
  leftOpen: boolean;
  rightOpen: boolean;
  /**
   * 右栏（代码查看器）在**桌面端**是否收起（窄屏不走它，走 `rightOpen` 抽屉）。
   * 本机偏好持久化在 localStorage `omni-right-collapsed`（见 LayoutController）。
   */
  rightCollapsed: boolean;
  memoryReloadKey: number;
  profilesReloadKey: number;
  graphRuns: Record<string, GraphRunState>;
  busy: boolean;
  activeTool: string | null;
  toastState: ToastState;
  paletteOpen: boolean;
  /** 会话列表是否显示**全部项目**（默认只显示当前项目；一键切换，见 SessionController.toggleSessionsScope）。 */
  sessionsScopeAll: boolean;
  /** 应用内对话框状态（替代 window.confirm / window.prompt）。 */
  dialog: DialogState;
  /** 本回合已累积的流式正文（`thread.text_delta` 增量拼接）。 */
  streamText: string;
  /** 已被 assistant 事件收口的流式文本（用于避免最终卡片重复播渐进揭示动画）。 */
  finalizedStreamText: string;
  /** 输入框回填指令（F4「编辑重发」：把末条用户消息填回底部输入框；null 表示无待回填内容）。 */
  composerSeed: ComposerSeed | null;
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
  /**
   * 路由导航：把局部路由补丁（pane / threadId）合并进当前路由并写入 hash，
   * 由 hashchange 订阅者统一收口状态（深链 / 浏览器前进后退由此驱动）。
   * @param partial 路由局部补丁；省略的字段沿用当前路由，threadId 传 null 表示清空。
   * @returns 无
   */
  navigate: (partial: Partial<AppRoute>) => void;
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
    /** 文件预览 / 代码查看器控制器（打开 / 切换 / 关闭文件标签）。 */
    files: FileController;
    /** 右栏网页标签控制器（地址导航 / 重载 / 关闭）。 */
    browser: BrowserController;
    /** 布局 / 主题偏好控制器（主题切换、面板开合、宽度持久化）。 */
    layout: LayoutController;
    /** 设置与界面语言控制器（设置模态开合 / 分栏定位 / locale 落盘）。 */
    settings: SettingsController;
    /** 全局快捷键解析器（无状态）。 */
    keyBindings: KeyboardShortcuts;
    /** 快捷键动作执行器（回调由组合根注入）。 */
    shortcuts: ShortcutActions;
  };
  /** 命令面板命令集（构造时一次性计算）。 */
  public commands: CommandItem[];
  /** 全局快捷键监听句柄（卸载时移除）。 */
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** 桌面通知/深链订阅（卸载时取消）。 */
  private desktopUnsubscribes: Array<() => void> = [];
  /**
   * 「断开」宽限期（毫秒）：SSE 抖动先显示「重连中」，超过该时长仍未重连上才判「断开」。
   *
   * 取值 4s 的依据：EventSource 的自动重连间隔由服务端的 `retry: 1000` 指定（1s），正常抖动
   * 一两秒内就能恢复；4s 足够覆盖，又不会把真正的断线藏太久。
   */
  private static readonly STREAM_DISCONNECT_GRACE_MS = 4_000;
  /** 宽限定时器句柄（null = 当前没有待判定的断线）。 */
  private streamGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 哈希路由绑定（F8：深链 / 浏览器前进后退，逻辑在 RouteBinding 内，避免越过上帝类红线）。 */
  private readonly routeBinding: RouteBinding;

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

  /** 文件预览 / 代码查看器子控制器（只读暴露给视图层）。 */
  public get files(): FileController {
    return this.children.files;
  }

  /** 右栏网页标签子控制器（只读暴露给视图层）。 */
  public get browser(): BrowserController {
    return this.children.browser;
  }

  /** 布局 / 主题偏好控制器（只读暴露给视图层）。 */
  public get layout(): LayoutController {
    return this.children.layout;
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
      navigate: (partial: Partial<AppRoute>) => this.routeBinding.navigate(partial),
    };
    const sessions = new SessionController(this.host, this.services);
    const graph = new GraphController(this.host, this.services);
    const composer = new ComposerController(this.host, this.services, sessions);
    const browser = new BrowserController(this.host, this.services);
    // 打开 HTML 时默认直接进网页预览（文件标签仍保留源码视图，点标签可切回）。
    const files = new FileController(this.host, this.services, (path) =>
      browser.previewFile(path),
    );
    const layout = new LayoutController(this.host);
    // 设置控制器要吃 layout（语言即时生效走它）与 services.api（落盘到用户级配置）。
    const settings = new SettingsController(this.host, { layout, api: this.services.api });
    this.children = {
      sessions,
      composer,
      graph,
      files,
      browser,
      layout,
      settings,
      keyBindings: new KeyboardShortcuts(),
      shortcuts: new ShortcutActions({
        togglePalette: () => this.host.patch((s) => ({ paletteOpen: !s.paletteOpen })),
        newSession: () => sessions.newSession(),
        toggleLeft: () => this.children.layout.toggleLeft(),
        toggleRight: () => this.children.layout.toggleRight(),
        toggleTheme: () => this.children.layout.toggleTheme(),
      }),
    };
    this.commands = this.buildCommands();
    // F8：路由绑定在组合根装配（需 children.sessions 作为打开会话回调）。
    this.routeBinding = new RouteBinding(this.host, (id: string) => void this.children.sessions.loadThread(id));
    // 绑定对外回调，保证作为 props 传递给子组件时 this 正确。
    // 2026-09-27：改为**按原型全量绑定**——手写清单曾漏掉 SessionController 的
    // rename/delete/fork（用户报「删除无效」，实为 this 丢失后的静默 unhandledRejection）。
    // 见 MethodBinder。
    MethodBinder.bindAll(this);
  }

  /** 挂载：绑定 toast / 对话框服务、拉取目录/配置、初始化主题、连接 SSE、刷新会话。 @returns 无 */
  public mount(): void {
    this.services.toastSvc.bind((message: string, kind?: ToastKind) => this.showToast(message, kind));
    this.services.dialogSvc.bind((state: DialogState) => this.host.patch({ dialog: state }));
    this.refreshModelCatalog();
    this.children.layout.initTheme();
    // 标签页标题也随语言走（index.html 里的静态 <title> 是中文，这里接管为 t() 文案）。
    document.title = t('OmniHarness 工作台');
    this.services.api
      .getConfig()
      .then((c) => {
        this.host.patch((s) => ({
          adapter: (c.modelAdapter || 'mock') + (c.model ? ' · ' + c.model : ''),
          model: c.model ? c.model : s.model,
          reasoning: c.reasoning ? c.reasoning : s.reasoning,
          permission: c.approval ? c.approval : s.permission,
        }));
        // 界面语言以**服务端配置为准**回灌（localStorage 只做首帧快速恢复的缓存）：
        // 配置真源是用户级 omniharness.json，跨设备/跨浏览器以它对齐。
        this.children.settings.applyConfigLocale(c.locale);
      })
      .catch(() => {});
    this.connectStream();
    // 启动时**连归档一起读一次**：此后日常刷新走快速路径（跳过归档文件的逐个扫描），而归档行已在内存
    // ⇒ `mergeSessions` 会一直保留它们（「已归档」组不会因为快速刷新而消失）。
    void this.children.sessions.refreshSessions(true);
    // F8：应用初始深链（面板 + 会话）并订阅浏览器前进 / 后退。
    this.routeBinding.start();
    // 桌面端：点击原生通知/深链后聚焦到对应会话（浏览器下 desktopBridge() 为 null，自动 no-op）。
    const bridge = desktopBridge();
    if (bridge !== null) {
      this.desktopUnsubscribes.push(
        bridge.onNotificationClick((sessionId) => {
          if (sessionId !== undefined && sessionId !== '') {
            this.services.navigate({ threadId: sessionId });
          }
        }),
      );
      this.desktopUnsubscribes.push(
        bridge.onDeepLink((url) => {
          try {
            const parsed = new URL(url);
            const threadId =
              parsed.searchParams.get('session') ?? parsed.searchParams.get('threadId');
            if (threadId !== null && threadId !== '') this.services.navigate({ threadId });
          } catch {
            // 非法深链忽略；主进程已做协议/目录校验。
          }
        }),
      );
    }
  }

  /** 卸载：关闭 SSE 流、移除全局快捷键与路由订阅。 @returns 无 */
  public unmount(): void {
    this.services.stream.close();
    this.clearStreamGrace();
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    for (const unsubscribe of this.desktopUnsubscribes) unsubscribe();
    this.desktopUnsubscribes = [];
    this.routeBinding.stop();
  }

  /** 清掉「断开」宽限定时器（重连成功 / 卸载时调用）。 @returns 无返回值 */
  private clearStreamGrace(): void {
    if (this.streamGraceTimer !== null) {
      clearTimeout(this.streamGraceTimer);
      this.streamGraceTimer = null;
    }
  }

  /** 连接 SSE 并把各消息方法路由到对应子控制器。 @returns 无 */
  public connectStream(): void {
    const stream = this.services.stream;
    // 连接态三态（2026-09-27 用户报「显示区域会出现显示断开」）：
    //   open       = 已连接（绿）
    //   connecting = 重连中（黄）——EventSource 的瞬时抖动（含每秒自动重连）都会先落到这里
    //   closed     = 断开（红）——只有在 `STREAM_DISCONNECT_GRACE_MS` 内一直没重连上才认定
    // 为什么要去抖：原先 `onClose` 一触发就把徽标刷成红色的「断开」，而 EventSource 本就是**自动重连**
    // 的（服务端正常情况下也不主动关流）⇒ 任何一次瞬时抖动都会让徽标闪一下红，用户看到的就是
    // 「显示断开」的假故障。宽限期内重连成功则完全无感。
    stream.onOpen = () => {
      this.clearStreamGrace();
      this.host.patch({ connected: true, streamState: 'open' });
    };
    stream.onClose = () => {
      this.host.patch({ connected: true, streamState: 'connecting' });
      this.clearStreamGrace();
      this.streamGraceTimer = setTimeout(() => {
        this.streamGraceTimer = null;
        this.host.patch({ connected: false, streamState: 'closed' });
      }, AppController.STREAM_DISCONNECT_GRACE_MS);
    };
    stream.onMessage = (msg: SseEnvelope) => {
      const params = msg.params as Record<string, unknown>;
      switch (msg.method) {
        case 'thread.event':
          this.children.sessions.handleEvent(params.event as ThreadEvent);
          break;
        case 'approval.request':
          this.host.patch({ approval: params as unknown as ApprovalRequest });
          notifyDesktop({
            title: '需要你的确认',
            body: '有一个工具调用等待审批，请回到 OmniHarness 处理。',
            ...(typeof params['threadId'] === 'string' ? { sessionId: params['threadId'] } : {}),
          });
          break;
        case 'question.request':
          // 提问上行：卡片由该通知驱动（**不**依赖对话流里的 question 事件——事件端口可能不接 Web）。
          this.host.patch({ question: params as unknown as QuestionRequest });
          notifyDesktop({
            title: '需要你的回答',
            body: 'Agent 正在等待你的回答。',
            ...(typeof params['threadId'] === 'string' ? { sessionId: params['threadId'] } : {}),
          });
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

  /**
   * 打开右侧某面板（F8：同步写入 hash，支持深链 / 前进后退）。
   * @param key 面板标识
   * @returns 无
   */
  public openPane(key: string): void {
    // 2026-10-19：功能面板改在模态里显示；openPane 的调用方（AddMenu 链接 / 设置里的跳转）
    // 需要同时把模态打开，否则只是改了 activePane、界面上什么都不会发生。
    this.host.patch({ panelModalOpen: key !== 'file', activePane: key });
    this.routeBinding.navigate({ pane: key });
  }

  /**
   * 设置子控制器（设置模态开合 / 分栏定位 / 界面语言）。
   *
   * 为什么搬出去（2026-10-17）：本类在 HEAD 时是 **25 个成员**——恰好顶在 `CODE_STANDARD`
   * 上帝类判据的线上（成员 > 25 即违规，且参与增量门禁）；设置这一组一次加了 5 个成员就把它
   * 推过了线。合并方法名去凑数只是把复杂度藏进参数，所以按"成员真正的主语"归位：
   * 设置模态与界面语言与「连接 SSE / 路由 / 审批」这些本职无关。
   * @returns 设置子控制器
   */
  public get settings(): SettingsController {
    return this.children.settings;
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
   * 响应审批（允许 / 拒绝），可选「总是允许」时写回 autoApprove。
   * @param decision 决策
   * @param always 是否记忆为始终允许
   * @returns 异步完成
   */
  public async respondApproval(decision: 'allow' | 'deny', always: boolean): Promise<void> {
    const req = this.host.getState().approval;
    if (!req) return;
    try {
      if (always) {
        await this.services.api.updateConfig({ autoApprove: true });
        decision = 'allow';
      }
      await this.services.api.respondApproval(req.requestId, decision);
      // **成功后才收卡片**：与 answerQuestion 同一纪律。先收卡片再发 RPC 会在失败时
      // 丢掉挂起（回合永久等待），而用户只看到一行 toast。
      this.host.patch({ approval: null });
    } catch (e) {
      this.services.toast(t('审批响应失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 提交提问作答：把作答送回等待中的 `ask_user`（`question.respond`）。
   *
   * 三种结果分开对待（**都不能乐观关闭卡片**，那正是用户以为「提交了」而回合还在等的成因）：
   * - RPC 抛错 ⇒ 没送到，保留卡片让用户重试；
   * - `{ ok: false, error: 'unknown_request' }` ⇒ 这次提问已经结束（超时/已被断连收尾/已作答过），
   *   卡片收掉并如实说明，避免留下一个点了永远报错的死卡；
   * - 其它 `{ ok: false }` ⇒ 送到了但被服务端校验拒绝（题 id / 选项标签 / 单选多选 / 长度），
   *   挂起仍保留，用户可以改正后重提。
   * @param answers 逐题作答（`selected` 必须是该题提供过的选项标签）
   * @returns 无
   */
  public async answerQuestion(answers: QuestionAnswerSubmission[]): Promise<void> {
    const request = this.host.getState().question;
    if (!request) return;
    try {
      const ack = await this.services.api.respondQuestion(request.requestId, answers);
      if (!ack.ok) {
        if (ack.error === 'unknown_request') {
          this.host.patch({ question: null });
          this.showToast(t('这次提问已经结束（超时或已作答），作答未送达'), 'err');
          return;
        }
        this.showToast(t('作答未被接受：{msg}', { msg: ack.error ?? t('未知原因') }), 'err');
        return;
      }
      this.host.patch({ question: null });
      this.showToast(t('回答已提交'), 'ok');
    } catch (e) {
      this.showToast(t('作答提交失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 提问等待到期（客户端倒计时归零）：服务端在**同一上限**按「未拿到回答」继续，
   * 这里只负责收起卡片并如实告知，避免留下一个「点了没反应」的死卡。
   * @param requestId 到期的那次提问 id（只收掉自己那次，防止竞态下误收新提问）
   * @returns 无
   */
  public expireQuestion(requestId: string): void {
    if (this.host.getState().question?.requestId !== requestId) return;
    this.host.patch({ question: null });
    this.showToast(t('提问等待超时，已按「未作答」继续'), 'info');
  }

  /**
   * 设置当前激活面板（PanelPicker / RightPanel 复用；F8：同步写入 hash）。
   * @param key 面板标识
   * @returns 无
   */
  public setActivePane(key: string): void {
    // 同上：命令面板 / 面板模态左导航都走这里。
    this.host.patch({ panelModalOpen: key !== 'file', activePane: key });
    this.routeBinding.navigate({ pane: key });
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
      sessionId: this.host.getState().currentThreadId,
      sessionTick: this.host.getState().sessionTick,
    };
  }

  /** 预计算命令面板命令集。 @returns 命令集 */
  private buildCommands(): CommandItem[] {
    return this.services.reducers.buildCommands({
      setActivePane: (key: string) => this.setActivePane(key),
      setRightOpen: (open: boolean) => this.host.patch({ rightOpen: open }),
      newSession: () => this.children.sessions.newSession(),
      refreshSessions: () => void this.children.sessions.refreshSessions(),
      toggleTheme: () => this.children.layout.toggleTheme(),
      toggleLeft: () => this.children.layout.toggleLeft(),
      toggleRight: () => this.children.layout.toggleRight(),
      openSettings: () => this.children.settings.open(),
    });
  }
}
