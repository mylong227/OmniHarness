import type { ToolDefinition } from '../../ports/tool/tool.js';
import { AppServerHandlers } from './appServerHandlers.js';
import type { AppServerOptions } from './appServerState.js';
import { ApprovalTierCatalog } from '../services/approvalTierCatalog.js';
import { AgentCatalogService } from '../services/agentCatalogService.js';
import { ContextUsageService } from '../services/contextUsageService.js';
import { SessionWorkspaceAssigner } from '../services/session/sessionWorkspaceAssigner.js';
import { ContextWindowCatalog } from '../../context/contextWindowCatalog.js';
import { QuotaService } from '../services/quotaService.js';
import { QuotaStore } from '../services/quotaStore.js';
import { SessionModeStore } from '../services/session/sessionModeStore.js';
import { TurnDirectiveComposer } from '../services/turnDirectiveComposer.js';
import { WorkspaceSearchService } from '../services/workspaceSearchService.js';

/**
 * AppServer 的「工作台界面能力」处理器：为 UI 的上下文容量面板、添加菜单与权限面板提供 RPC。
 *
 * 独立成一层（`AppServerBase → AppServerHandlers → AppServerSurfaceHandlers → AppServer`）而不是
 * 继续往 `AppServerHandlers` 里堆方法：那一层的职责是「插件集 / 发布单元 / 插件市场」，
 * 与本层的「会话容量 / 配额 / 模式 / 检索 / 档位表」没有语义重合，混在一起会让
 * 「一个类一个功能点」失守，也让新能力的协作者装配无处安放。
 *
 * 本层只做两件事：装配协作者、把 RPC 参数校验后转发。领域逻辑一律在协作者里（各自可单测）。
 */
export class AppServerSurfaceHandlers extends AppServerHandlers {
  /** 上下文容量报告（六类分解 + 缓存命中率）。 */
  protected readonly contextUsage: ContextUsageService;
  /** 本地日内预算配额。 */
  protected readonly quota: QuotaService;
  /** 会话模式（目标 / 计划 / 绘图）存储。 */
  protected readonly modes: SessionModeStore;
  /** 回合前置指令合成器（turns.run 读模式用）。 */
  protected readonly directives: TurnDirectiveComposer;
  /** 审批档位表（UI 权限面板单一来源）。 */
  protected readonly approvalTiers: ApprovalTierCatalog;
  /** 智能体目录。 */
  protected readonly agents: AgentCatalogService;
  /** 工作区 + 会话检索。 */
  protected readonly search: WorkspaceSearchService;
  /** 上下文窗口目录（`context.usage` 与 `context.window` 共用同一份解析口径）。 */
  protected readonly windows: ContextWindowCatalog;

  /**
   * @param options 服务端选项（与基座同一份，装配期只读使用）
   */
  public constructor(options: AppServerOptions) {
    super(options);
    const workspaceRoot = (): string => this.configStore.workspace();
    this.windows = new ContextWindowCatalog(this.envWindow());
    this.contextUsage = new ContextUsageService({
      replay: (threadId) => this.runtime.agent().replay(threadId),
      tools: () => this.visibleTools(),
      baseFragments: () => this.options.config.fragments ?? [],
      model: () => this.options.config.model.name,
    });
    this.quota = new QuotaService({
      store: new QuotaStore(workspaceRoot),
      usage: this.sessionArchive,
      models: () => this.activeModels(),
    });
    this.modes = new SessionModeStore(workspaceRoot);
    this.directives = new TurnDirectiveComposer();
    this.approvalTiers = new ApprovalTierCatalog();
    this.agents = new AgentCatalogService({
      graphs: () => this.runtime.graphStore().list(),
      plugins: () => this.installedPlugins(),
    });
    this.search = new WorkspaceSearchService({
      workspaceRoot,
      chats: () => this.sessionList(),
    });
  }

  /**
   * `context.usage` 的目标会话：请求里给了就用它，**没给就回落到正在跑的会话**。
   *
   * 为什么必须回落（2026-10-07 用户实测「不会实时计算显示刷新容量面板上的数据」）：
   * 新会话的 `threadId` 要等 `turns.run` 返回之后客户端才知道，而容量面板在**第一回合进行中**
   * 就已经打开了（用户就是在这时候看的）——此时客户端只能传空串，服务端原样返回全零报告
   * （`source: 'empty'`），面板于是整段时间显示 `0/12.8万`。回合进行中服务端**本来就知道**
   * 真正的会话 id（`Agent.runningSessionIds()`，插入序 ⇒ 末条最新），回落即可给出真实数字。
   * @param requested 请求里的 threadId（可能为空串）。
   * @returns 用于取数的会话 id（可能仍为空串：确实没有任何在跑会话时）。
   */
  protected usageThreadId(requested: string): string {
    if (requested !== '') return requested;
    const running = this.runtime.agent().runningSessionIds();
    return running.length === 0 ? '' : running[running.length - 1]!;
  }

  /**
   * 注册上下文容量 / 配额 / 模式 / 检索 / 档位表 / 智能体目录 RPC。
   * @returns 无返回值。
   */
  protected registerSurfaceHandlers(): void {
    this.handlers.set('context.usage', async (params) =>
      this.contextUsage.usage(this.usageThreadId(this.stringParam(params, 'threadId'))),
    );
    this.handlers.set('quota.get', async () => this.quota.status());
    this.handlers.set('quota.set', async (params) => {
      const patch: { plan?: string; dailyTokens?: number } = {};
      const plan = params['plan'];
      if (typeof plan === 'string' && plan !== '') patch.plan = plan;
      const daily = params['dailyTokens'];
      if (typeof daily === 'number') patch.dailyTokens = daily;
      return this.quota.update(patch);
    });
    this.handlers.set('modes.get', async (params) =>
      this.modes.get(this.stringParam(params, 'threadId')),
    );
    this.handlers.set('modes.set', async (params) => {
      const threadId = this.stringParam(params, 'threadId');
      if (threadId === '') throw new Error('modes.set 需要 threadId');
      const patch: { goal?: string; planMode?: boolean; sketchMode?: boolean } = {};
      const goal = params['goal'];
      if (typeof goal === 'string') patch.goal = goal;
      const planMode = params['planMode'];
      if (typeof planMode === 'boolean') patch.planMode = planMode;
      const sketchMode = params['sketchMode'];
      if (typeof sketchMode === 'boolean') patch.sketchMode = sketchMode;
      return this.modes.set(threadId, patch);
    });
    this.handlers.set('modes.clear', async (params) => {
      const threadId = this.stringParam(params, 'threadId');
      if (threadId === '') throw new Error('modes.clear 需要 threadId');
      return this.modes.clear(threadId);
    });
    // 把会话**归入指定项目**（侧栏右键「归入当前项目」）：只改存档首行 session_meta.workspace；
    // 目标目录先经 configStore 校验存在（fail-closed），运行中的会话由存档的 runningChecker 拒绝。
    this.handlers.set('sessions.setWorkspace', async (params) =>
      SessionWorkspaceAssigner.assign(
        this.options.config.storage.location ?? '',
        this.stringParam(params, 'sessionId'),
        this.configStore.requireDirectory(this.stringParam(params, 'workspace')),
      ),
    );
    this.handlers.set('approval.tiers', async () => ({ tiers: this.approvalTiers.all() }));
    this.handlers.set('agents.list', async () => this.agents.list());
    this.handlers.set('search.all', async (params) => {
      const query = this.stringParam(params, 'query');
      const limit = typeof params['limit'] === 'number' ? (params['limit'] as number) : undefined;
      return this.search.search(query, limit);
    });
    this.handlers.set('context.window', async () => ({
      model: this.options.config.model.name,
      windowTokens: this.windows.of(this.options.config.model.name),
    }));
  }

  /**
   * 取字符串参数（非字符串或空即空串，交由调用方决定是否报错）。
   * @param params RPC 参数对象。
   * @param key 参数键名。
   * @returns 字符串值；缺省 / 类型不符时为空串。
   */
  private stringParam(params: Record<string, unknown>, key: string): string {
    const value = params[key];
    return typeof value === 'string' ? value : '';
  }

  /**
   * 本轮可能进入模型视野的工具（直载优先，未实现 listDirect 时退回全量）。
   * @returns 工具定义数组。
   */
  private visibleTools(): readonly ToolDefinition[] {
    const tools = this.options.config.tools;
    return tools.listDirect?.() ?? tools.list();
  }

  /**
   * env `OMNI_CONTEXT_WINDOW` 覆盖值（非法/未设返回 undefined）。
   * @returns 覆盖的窗口 token 数；未设或非法时 undefined。
   */
  private envWindow(): number | undefined {
    const raw = Number(process.env.OMNI_CONTEXT_WINDOW);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }

  /**
   * 当前 active 厂商的可用模型清单（catalog 为 unknown，此处窄化后取 models）。
   * @returns 模型名字符串数组（结构不符时为空数组）。
   */
  private activeModels(): readonly string[] {
    const catalog = this.modelCatalog.catalog() as { active?: { models?: unknown } } | undefined;
    const models = catalog?.active?.models;
    return Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : [];
  }

  /**
   * 已安装插件清单（注册表未注入时为空；读取失败同样为空，不让智能体列表整体报错）。
   * @returns 插件摘要数组（name / version / 可选 description）。
   */
  private async installedPlugins(): Promise<
    readonly { name: string; version: string; description?: string }[]
  > {
    const registry = this.options.registry;
    if (registry === undefined) return [];
    try {
      const list = await registry.list();
      return list as readonly { name: string; version: string; description?: string }[];
    } catch {
      return [];
    }
  }

  /**
   * 会话清单（`search.all` 的聊天来源；读取失败返回空表）。
   * @returns 会话摘要数组（sessionId / label / 可选 workspace / updatedAt）。
   */
  private sessionList(): readonly {
    sessionId: string;
    label: string;
    workspace?: string;
    updatedAt: string;
  }[] {
    // `'*'`：检索面要看**全量**会话（`search.all` 跨项目可搜），按当前工作区过滤会把搜索结果
    // 静默缩小到一个项目（见 SessionArchive.list 的作用域语义）。
    const listed = this.sessionArchive.list(true, '*') as {
      sessions?: readonly {
        sessionId: string;
        label: string;
        workspace?: string;
        updatedAt: string;
      }[];
    };
    return listed.sessions ?? [];
  }
}
