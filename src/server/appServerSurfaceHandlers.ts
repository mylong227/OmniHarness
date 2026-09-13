import type { ToolDefinition } from '../ports/tool/tool.js';
import { AppServerHandlers } from './appServerHandlers.js';
import type { AppServerOptions } from './appServerState.js';
import { ApprovalTierCatalog } from './approvalTierCatalog.js';
import { AgentCatalogService } from './agentCatalogService.js';
import { ContextUsageService } from './contextUsageService.js';
import { ContextWindowCatalog } from '../context/contextWindowCatalog.js';
import { QuotaService } from './quotaService.js';
import { QuotaStore } from './quotaStore.js';
import { SessionModeStore } from './sessionModeStore.js';
import { TurnDirectiveComposer } from './turnDirectiveComposer.js';
import { WorkspaceSearchService } from './workspaceSearchService.js';

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
   * 注册上下文容量 / 配额 / 模式 / 检索 / 档位表 / 智能体目录 RPC。
   * @returns 无返回值。
   */
  protected registerSurfaceHandlers(): void {
    this.handlers.set('context.usage', async (params) =>
      this.contextUsage.usage(this.stringParam(params, 'threadId')),
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
    const listed = this.sessionArchive.list() as {
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
