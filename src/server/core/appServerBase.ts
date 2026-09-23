import type { ResolvedConfig } from '../../config/configFactory.js';
import { ConfigFactory } from '../../config/configFactory.js';
import { ConfigRebase } from '../../config/configRebase.js';
import { SandboxManager, type SandboxProfile } from '../../adapters/sandbox/sandboxManager.js';
import type { PluginManager } from '../../plugin/pluginManager.js';
import type { PluginProfile, ApplyProfileResult } from '../../plugin/pluginProfileStore.js';
import type { SupervisorPort } from '../../ports/runtime/supervisor.js';
import { jsonRpc, type RpcMessage } from './jsonRpc.js';
import type { AppServerOptions, GraphRunState } from './appServerState.js';
import { ServerConfigStore } from '../services/serverConfigStore.js';
import { FsExplorer } from '../services/fsExplorer.js';
import { WorkspaceTree } from '../services/workspaceTree.js';
import { SessionArchive } from '../services/sessionArchive.js';
import { WorkspaceChanges } from '../services/workspaceChanges.js';
import { ModelCatalogService } from '../services/modelCatalogService.js';
import { PluginHost } from '../services/pluginHost.js';
import { ServerEventBridge } from './serverEventBridge.js';
import { AgentRuntimeHost } from './agentRuntimeHost.js';

/**
 * AppServer 共享基座：**组合根 + 方法调度**。
 *
 * 只保留三件事：
 *   1. RPC 分发（`handlers` 表 + `handle`）与跨域共享状态（`threads` / `activeTurns` / `graphRuns`）；
 *   2. 装配 9 个单一职责协作者（配置 / 文件系统 / 会话存档 / 变更 / 模型目录 / 插件 / 事件桥 / 运行时 / 树）；
 *   3. 少量跨域编排（`switchWorkspace`）与对外稳定契约（`loadPlugins` / `applyPluginProfile` /
 *      `effectiveWorkspace` / `updateConfig` / `bypassSupervisorKernel`）。
 *
 * 领域逻辑一律下沉到协作者（各自独立可测、可复用），继承链
 * `AppServerBase → AppServerHandlers → AppServer` 保持原样，导出名与路径不变。
 */
export class AppServerBase {
  /** 服务端选项（配置、传输、技能、指标、审计、插件目录等；switchWorkspace 会原地替换其中 config）。 */
  protected options: AppServerOptions;
  /** 线程 id 自映射（存在性判定用）。 */
  protected readonly threads = new Map<string, string>();
  /** 正在执行回合的会话 id（runTurn 进入/退出维护）：sessions.list 据此标注真实运行态（非猜测）。 */
  protected readonly activeTurns = new Set<string>();
  /** RPC 方法表。 */
  protected readonly handlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<unknown>
  >();
  /** 进行中的图运行态（runId → 状态），供 graph.status 查询。 */
  protected readonly graphRuns = new Map<string, GraphRunState>();

  /** 配置存储（UI 覆盖 + 落盘 + 工作区列表）。 */
  protected readonly configStore: ServerConfigStore;
  /** 文件对话框 RPC（浏览 / 新建 / 附件）。 */
  protected readonly fsExplorer: FsExplorer;
  /** 工作区内文件树与读取。 */
  protected readonly workspaceTree: WorkspaceTree;
  /** 会话存档读取（用量 / 列表）。 */
  protected readonly sessionArchive: SessionArchive;
  /** 工作区变更清单（git / 会话回退）。 */
  protected readonly workspaceChanges: WorkspaceChanges;
  /** 模型目录与厂商探测。 */
  protected readonly modelCatalog: ModelCatalogService;
  /** 插件宿主。 */
  protected readonly plugins: PluginHost;
  /** 事件/审批桥。 */
  protected readonly events: ServerEventBridge;
  /** Agent 与图运行时宿主。 */
  protected readonly runtime: AgentRuntimeHost;

  /**
   * @param options 服务端选项（配置、传输、技能、指标、审计、插件目录/注册表等）
   */
  public constructor(options: AppServerOptions) {
    this.options = options;
    // 工作区根以 getter 注入各协作者：支持运行时 workspace.switch 后仍取到最新根。
    const workspaceRoot = (): string => this.configStore.workspace();
    this.fsExplorer = new FsExplorer();
    this.workspaceTree = new WorkspaceTree({ workspaceRoot });
    this.modelCatalog = new ModelCatalogService({
      fileConfig: () => this.configStore.fileConfig(),
      adapterOverride: () => this.configStore.adapterOverride(),
    });
    this.configStore = new ServerConfigStore({
      displayConfig: options.displayConfig ?? {},
      configPath: options.configPath,
      autoApprove: options.autoApprove ?? false,
      probeProvider: (preset, key) => this.modelCatalog.cacheProbe(preset, key),
      onChanged: () => this.runtime.invalidateAgent(),
    });
    this.sessionArchive = new SessionArchive({
      workspaceRoot,
      storageLocation: () => this.options.config.storage.location,
      configuredStorageDir: () => this.configStore.fileConfig().storageDir,
      metrics: options.metrics,
    });
    // 注入真实运行态判定：运行中的会话拒绝删除，避免截断活动事件流。
    this.sessionArchive.setRunningChecker((id) => this.activeTurns.has(id));
    this.workspaceChanges = new WorkspaceChanges({
      workspaceRoot,
      threadIds: () => this.threads.keys(),
      replay: (threadId) => this.runtime.agent().replay(threadId),
    });
    this.events = new ServerEventBridge({
      transport: options.transport,
      metrics: options.metrics,
      audit: options.audit,
    });
    // 客户端全部断开 ⇒ 立即把挂起的审批上行按 deny 兑现（fail-closed）。
    // 为什么需要：审批是「等客户端回答」的，页面一关就再也不会有人回答；只靠超时兜底会让回合
    // 白等一整个超时窗口（默认 120s）才收尾，期间 activeTurns 一直是 running（2026-09-22 修，审计 P2）。
    options.transport.setOnAllClientsGone?.(() => {
      this.events.denyAllPending('客户端全部断开（页面关闭 / 连接断开）');
    });
    this.plugins = new PluginHost({
      pluginsDir: options.pluginsDir,
      baseConfig: () => this.options.config,
      transport: options.transport,
      registry: options.registry,
      messageOf: (error) => this.messageOf(error),
    });
    this.runtime = new AgentRuntimeHost({
      baseConfig: () => this.options.config,
      skills: options.skills,
      eventPort: () => this.events.eventPort(),
      approvalUplink: options.approvalUplink === true,
      autoApprove: () => this.configStore.autoApprove,
      approvalOverride: () => this.configStore.approvalOverride(),
      uplink: () => this.events.approvalPort(),
      modelOverride: () =>
        options.modelOverrideEnabled === false ? undefined : this.modelCatalog.resolveOverride(),
      workspaceRoot,
    });
  }

  /** 可读配置摘要（字符串标识）——子类读取初始展示字段。 */
  protected get displayConfig(): Record<string, string> {
    return this.options.displayConfig ?? {};
  }

  /** 插件管理器（子类 handler 复用）。 */
  protected get pluginManager(): PluginManager | undefined {
    return this.plugins.manager;
  }

  /** 插件安装目录（子类 handler 复用）。 */
  protected get pluginsDir(): string | undefined {
    return this.plugins.dir;
  }

  /**
   * 启动阶段加载已安装插件（闭环 G-B：市场安装 → 运行时可用）。
   * @returns 加载完成后 resolve，无载荷。
   */
  public async loadPlugins(): Promise<void> {
    await this.plugins.load();
  }

  /**
   * 应用插件集 Profile（CLI --plugin-profile / 编程入口复用）。
   * @param profile 插件集档案（启用的插件与来源配置）。
   * @returns 应用结果（成功 / 失败明细）。
   */
  public async applyPluginProfile(profile: PluginProfile): Promise<ApplyProfileResult> {
    return this.plugins.applyProfile(profile);
  }

  /**
   * 处理入站消息。
   * @param message 入站 RPC 消息（非请求或未知方法按协议回错误响应）。
   * @returns 处理完成（响应已写回传输层）后 resolve，无载荷。
   */
  protected async handle(message: RpcMessage): Promise<void> {
    if (!jsonRpc.isRequest(message)) {
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      this.options.transport.send(
        jsonRpc.errorResponse(message.id, -32601, `方法不存在: ${message.method}`),
      );
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      this.options.transport.send(jsonRpc.response(message.id, result));
    } catch (error) {
      this.options.transport.send(jsonRpc.errorResponse(message.id, -32000, this.messageOf(error)));
    }
  }

  /**
   * 提取错误消息。
   * @param error 任意抛出值。
   * @returns Error 取 message，其余值 String() 化。
   */
  protected messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 更新服务端配置（委托配置存储；保留为方法以稳定对外契约）。
   * @param params `config.update` 的参数（待更新的配置键值）。
   * @returns 配置存储的更新结果。
   */
  protected async updateConfig(params: Record<string, unknown>): Promise<unknown> {
    return this.configStore.update(params);
  }

  /**
   * 当前生效的工作区根（#OBS-11）：HTTP /files 路由与 RPC fs.read 共用。
   * public：HTTP 路由需要直接读取以注入到 HttpServerOptions.workspaceRoot。
   * @returns 当前工作区根目录路径。
   */
  public effectiveWorkspace(): string {
    return this.configStore.workspace();
  }

  /**
   * 是否放宽 SupervisorKernel（委托运行时宿主；保留为方法以稳定对外契约）。
   * @param config 解析后的配置（含放宽开关）。
   * @returns 放宽时返回替代监督实现；不放宽返回 undefined。
   */
  protected bypassSupervisorKernel(config: ResolvedConfig): SupervisorPort | undefined {
    return this.runtime.bypassSupervisorKernel(config);
  }

  /**
   * 「切换项目」：按新工作区根目录重建运行时组件（sandbox/hooks/memory/spill 等全部
   * 随 ConfigFactory.build 按新 root 重造），清 agent/graph 缓存，下回合即在新工作区执行。
   * 审批/模型覆盖沿用现有解析逻辑，UI 感知零断裂。
   *
   * **2026-09-19 修复（声明未接线）**：原实现手工只传 9 个键调 `ConfigFactory.build`，
   * 其余声明式字段（最要命的是 `fragments` —— 系统提示的唯一注入通道）**被静默丢弃**，
   * 于是「切换工作区」等于「模型从此失去全部行为准则」。
   * 现改走 {@link ConfigRebase.forWorkspace}：以旧配置为基线重基，只剔除工作区耦合端口。
   *
   * @param raw 新工作区根目录（未知类型，经 requireDirectory 校验）
   * @returns `{ ok, workspace, unchanged? }` 或 `{ ok, workspace, workspaces }`
   */
  protected switchWorkspace(raw: unknown): unknown {
    const root = this.configStore.requireDirectory(raw);
    const previous = this.configStore.workspace();
    if (root === previous) {
      return { ok: true, workspace: root, unchanged: true };
    }
    const cfg = this.options.config;
    const file = this.configStore.fileConfig();
    const sandbox = new SandboxManager(root).build((file.sandbox ?? 'policy') as SandboxProfile);
    const rebuilt = ConfigFactory.build({
      ...ConfigRebase.forWorkspace(cfg, root),
      maxSteps: cfg.maxSteps,
      model: this.modelCatalog.resolveOverride() ?? cfg.model,
      storage: cfg.storage,
      events: this.events.eventPort(),
      approvals: this.runtime.resolveApprovals(cfg),
      sandbox,
      escalation: cfg.escalation,
      reasoning: file.reasoning ?? cfg.reasoning,
    });
    (this.options as { config: ResolvedConfig }).config = rebuilt;
    this.runtime.invalidateAgent();
    this.runtime.invalidateGraph();
    const workspaces = this.configStore.commitWorkspaceSwitch(root, previous);
    return { ok: true, workspace: root, workspaces: workspaces.workspaces };
  }

  /**
   * 线程结果。
   * @param result agent 运行结果（sessionId、finalText、steps）。
   * @returns 对外线程结果形（threadId / finalText / steps）。
   */
  protected threadResult(result: {
    sessionId: string;
    finalText?: string | undefined;
    steps: number;
  }): unknown {
    return { threadId: result.sessionId, finalText: result.finalText, steps: result.steps };
  }
}
