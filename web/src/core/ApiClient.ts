// 面向对象的服务层：封装与后端的所有 JSON-RPC 2.0 通信与 /metrics 拉取。
// 组件层只依赖本类，不直接 fetch，便于替换与单测。

import type {
  Config,
  FileAttachment,
  FsNode,
  FsReadResult,
  GraphDef,
  GraphGetResult,
  GraphRunResult,
  GraphStatusResult,
  GraphSummary,
  MemoryListResult,
  MemorySearchResult,
  Metrics,
  PluginReloadResult,
  PluginSearchEntry,
  PluginManifest,
  Profile,
  ActivePlugins,
  ProfileApplyResult,
  BundlePackResult,
  BundleUnpackResult,
  ThreadGetResult,
  TurnRunResult,
} from '../types/models.js';

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: JsonRpcError;
}

export class ApiClient {
  private nextId = 0;

  /** 统一的 JSON-RPC 2.0 调用入口；失败时抛出带服务端 message 的 Error。 */
  public async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    const res = await fetch('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const data = (await res.json()) as JsonRpcResponse<T>;
    if (data && data.error) {
      throw new Error(data.error.message || 'RPC 错误');
    }
    return data.result as T;
  }

  /**
   * 拉取 /metrics 并解析。服务端返回 Prometheus 文本格式（# HELP / metric lines），
   * 此处做轻量解析：omni_sessions gauge → sessions；omni_events_total{type="x"} → eventsByType。
   * 早期版本误用 res.json() 解析必挂，导致指标面板永远停在「读取中…」。
   */
  public async fetchMetrics(): Promise<Metrics> {
    const res = await fetch('/metrics');
    if (!res.ok) throw new Error('metrics 请求失败：' + res.status);
    const text = await res.text();
    const metrics: Metrics = { sessions: 0, eventsByType: {} };
    const labelOf = (line: string, key: string): string | undefined => {
      const m = line.match(new RegExp(key + '="([^"]*)"'));
      return m?.[1];
    };
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const sp = line.lastIndexOf(' ');
      if (sp <= 0) continue;
      const name = line.slice(0, sp).replace(/\{.*\}$/, '').trim();
      const value = Number(line.slice(sp + 1).trim());
      if (!Number.isFinite(value)) continue;
      if (name === 'omni_sessions') {
        metrics.sessions = Math.round(value);
      } else if (name === 'omni_events_total') {
        const type = labelOf(line, 'type');
        if (type !== undefined) metrics.eventsByType![type] = Math.round(value);
      }
    }
    return metrics;
  }

  // ---- 任务 / 会话 ----
  public runTurn(
    params: { threadId?: string; prompt: string; images?: { url?: string; data?: string; mediaType?: string }[]; files?: FileAttachment[] },
  ): Promise<TurnRunResult> {
    return this.rpc('turns.run', params);
  }
  /**
   * 中断在跑回合：后端取消令牌中止在飞模型请求，turns.run 自然收尾。
   * @returns 中断 RPC 的响应（{ ok: true }）。
   */
  public abortTurn(): Promise<unknown> {
    return this.rpc('turns.abort', {});
  }
  public getThread(threadId: string): Promise<ThreadGetResult> {
    return this.rpc('threads.get', { threadId });
  }
  /**
   * 服务端回退：把持久化事件流截断到 keepEventId（含）。
   * 「重生成」必须经此返回**服务端**再重发——只截断视图层的话，服务端 jsonl 里的旧一轮仍在，
   * 下一回合的模型上下文照旧包含旧回答（刷新页面旧回答还会复现）。
   * @param threadId 目标线程
   * @param keepEventId 保留到哪条事件（含）
   * @returns 保留/丢弃条数；失败时为 `{ ok: false, error }`（不抛错，前端直接把原因展示出来）
   */
  public rewindThread(
    threadId: string,
    keepEventId: string,
  ): Promise<{ ok: boolean; kept?: number; dropped?: number; error?: string }> {
    return this.rpc('threads.rewind', { threadId, keepEventId });
  }

  // ---- 配置 / 审批 ----
  public getConfig(): Promise<Config> {
    return this.rpc('config.get', {});
  }
  public updateConfig(patch: Record<string, unknown>): Promise<unknown> {
    return this.rpc('config.update', patch);
  }
  /** 厂商目录（#模型接入页）：服务端单一下发，含当前厂商与其可用模型 + 该厂商合法 reasoning_effort 档位。 */
  public modelCatalog(): Promise<{
    providers: import('../types/models.js').ProviderPreset[];
    active?: {
      id: string;
      label: string;
      defaultModel: string;
      model?: string;
      models: string[];
      /** 当前厂商合法 reasoning_effort 档位（#B6 扩展，2026-09-08）：undefined/[] 用 UI 兜底。 */
      reasoningEffort?: string[];
    };
  }> {
    return this.rpc('model.catalog', {});
  }
  /** Token 消耗统计：按模型 / 按会话聚合调用次数与 token 用量。 */
  public usageStats(): Promise<{
    source: 'disk' | 'live';
    dir: string;
    byModel: Record<string, { calls: number; prompt: number; completion: number; total: number }>;
    total: { calls: number; prompt: number; completion: number; total: number };
    sessions: { sessionId: string; calls: number; total: number }[];
  }> {
    return this.rpc('usage.stats', {});
  }
  /** 厂商连通探测：真实请求 /models，返回实测状态与模型清单。 */
  public probeModels(provider?: string): Promise<{ providers: import('../types/models.js').ProviderProbeResult[] }> {
    return this.rpc('model.probe', provider ? { provider } : {});
  }
  /** 工作区列表（当前 + 已添加项目）。 */
  public listWorkspaces(): Promise<{ current: string; workspaces: string[] }> {
    return this.rpc('workspace.list', {});
  }
  /** 全部会话存档列表（含工作区标记），供按项目收纳。running = 服务端真实运行态。 */
  public listSessions(): Promise<{
    dir: string;
    sessions: {
      sessionId: string;
      workspace?: string;
      label: string;
      turns: number;
      updatedAt: string;
      running?: boolean;
    }[];
  }> {
    return this.rpc('sessions.list', {});
  }
  /** 重命名会话（自定义标题，空串清除）；服务端写入侧车，列表回落首条用户消息。 */
  public renameSession(sessionId: string, title: string): Promise<{ ok: boolean; error?: string }> {
    return this.rpc('sessions.rename', { sessionId, title });
  }
  /** 删除会话存档；运行中的会话被服务端拒绝。 */
  public deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.rpc('sessions.delete', { sessionId });
  }
  /** 分叉会话为带新 id 的副本；返回新会话 id。 */
  public forkSession(sessionId: string): Promise<{ ok: boolean; newSessionId?: string; error?: string }> {
    return this.rpc('sessions.fork', { sessionId });
  }
  /** 工作区变更记录（git 式）；传 path 时返回该文件 patch。 */
  public listChanges(path?: string): Promise<{
    source: string;
    branch?: string;
    files?: { path: string; status: string; additions: number; deletions: number }[];
    patch?: string;
  }> {
    return this.rpc('changes.list', path ? { path } : {});
  }
  /** 添加项目文件夹（服务端校验目录存在后持久化）。 */
  public addWorkspace(path: string): Promise<{ current: string; workspaces: string[] }> {
    return this.rpc('workspace.add', { path });
  }

  /** 服务端目录浏览（+ 添加项目的文件夹选择器 / 附件文件选择器数据源）。
   *  includeFiles=true 时同时返回当前目录下的文件清单（附件 FilePicker 复用）。 */
  public browseFs(
    path?: string,
    includeFiles?: boolean,
  ): Promise<
    | { level: 'drives'; roots: string[]; home: string }
    | {
        level: 'dir';
        path: string;
        parent?: string;
        dirs: string[];
        files?: { name: string; size: number; mediaType: string }[];
      }
  > {
    return this.rpc('fs.browse', { path, includeFiles });
  }
  /** 新建文件夹（+ 新建项目）：在 parent 目录下创建 name，返回新目录绝对路径。 */
  public mkdirFs(parent: string, name: string): Promise<{ path: string }> {
    return this.rpc('fs.mkdir', { parent, name });
  }
  /** 附件读取（FilePicker 选完文件后批量读 base64）：不限工作区，类型/大小白名单。
   *  单文件失败不阻断整体，结果按 files/errors 分开返回。 */
  public attachRead(paths: string[]): Promise<{
    files: {
      name: string;
      mediaType: string;
      data: string;
      size: number;
      kind: 'image' | 'video' | 'audio' | 'file';
    }[];
    errors: { path: string; error: string }[];
  }> {
    return this.rpc('attach.read', { paths });
  }
  /** 切换项目：服务端重建运行时组件，下回合即在新工作区执行。 */
  public switchWorkspace(path: string): Promise<{ ok: boolean; workspace: string }> {
    return this.rpc('workspace.switch', { path });
  }
  public respondApproval(requestId: string, decision: string): Promise<unknown> {
    return this.rpc('approval.respond', { requestId, decision });
  }

  /** 列出某会话的全部检查点（label/时间/事件数/是否含文件快照）。 */
  public listCheckpoints(sessionId: string): Promise<{
    sessionId: string;
    checkpoints: { label: string; ts: string; eventCount: number; hasFileSnapshot: boolean }[];
  }> {
    return this.rpc('checkpoint.list', { sessionId });
  }
  /** 为当前会话创建一个检查点（对话 + 工作区文件快照）。 */
  public createCheckpoint(
    sessionId: string,
    label: string,
  ): Promise<{ ok: boolean; checkpoint: { label: string; ts: string; eventCount: number; hasFileSnapshot: boolean } }> {
    return this.rpc('checkpoint.create', { sessionId, label });
  }
  /** 回滚到指定检查点（不传 label 回滚到最近一个）；对话与代码一并还原。 */
  public rollbackCheckpoint(
    sessionId: string,
    label?: string,
  ): Promise<{ ok: boolean; checkpoint: { label: string; ts: string; eventCount: number; hasFileSnapshot: boolean } }> {
    return this.rpc('checkpoint.rollback', { sessionId, label });
  }

  // ---- 内联 diff 审查（对标 Codex Review：hunk 级 stage/revert + 行内评论）----

  /** stage 整个文件（git add）。 */
  public stageFile(path: string): Promise<{ ok: boolean }> {
    return this.rpc('changes.stageFile', { path });
  }
  /** 丢弃整个文件的工作区改动（未跟踪文件服务端拒绝）。 */
  public revertFile(path: string): Promise<{ ok: boolean }> {
    return this.rpc('changes.revertFile', { path });
  }
  /** stage 单个 hunk；isNew=true 时服务端先 git add -N。 */
  public stageHunk(path: string, hunk: string, isNew?: boolean): Promise<{ ok: boolean }> {
    return this.rpc('changes.stageHunk', { path, hunk, isNew });
  }
  /** 丢弃单个 hunk 的工作区改动（git apply -R）。 */
  public revertHunk(path: string, hunk: string): Promise<{ ok: boolean }> {
    return this.rpc('changes.revertHunk', { path, hunk });
  }
  /** 全部行内评论（工作区级持久化）。 */
  public listDiffComments(): Promise<{
    comments: { id: string; path: string; side: 'old' | 'new'; line: number; text: string; ts: string }[];
  }> {
    return this.rpc('changes.comments.list', {});
  }
  /** 添加行内评论（锚定 文件 + 行号 + 侧别）。 */
  public addDiffComment(
    path: string,
    side: 'old' | 'new',
    line: number,
    text: string,
  ): Promise<{ ok: boolean; comment: { id: string; path: string; side: 'old' | 'new'; line: number; text: string; ts: string } }> {
    return this.rpc('changes.comments.add', { path, side, line, text });
  }
  /** 删除一条行内评论。 */
  public deleteDiffComment(id: string): Promise<{ ok: boolean }> {
    return this.rpc('changes.comments.delete', { id });
  }

  // ---- 文件树 ----
  public listFs(depth = 3): Promise<{ tree: FsNode[] }> {
    return this.rpc('fs.list', { depth });
  }
  public readFs(path: string): Promise<FsReadResult> {
    return this.rpc('fs.read', { path });
  }

  // ---- 插件 ----
  public listPlugins(): Promise<PluginManifest[]> {
    return this.rpc('plugins.list', {});
  }
  public searchPlugins(query = ''): Promise<PluginSearchEntry[]> {
    return this.rpc('plugins.search', { query });
  }
  public installPlugin(name: string): Promise<unknown> {
    return this.rpc('plugins.install', { name });
  }
  public removePlugin(name: string): Promise<unknown> {
    return this.rpc('plugins.remove', { name });
  }
  public reloadPlugins(): Promise<PluginReloadResult> {
    return this.rpc('plugins.reload', {});
  }

  // ---- 长期记忆 ----
  public listMemory(): Promise<MemoryListResult> {
    return this.rpc('memory.list', {});
  }
  public searchMemory(query: string, limit = 20): Promise<MemorySearchResult> {
    return this.rpc('memory.search', { query, limit });
  }
  public addMemory(fact: { text: string; topic?: string; importance?: number }): Promise<unknown> {
    return this.rpc('memory.add', fact);
  }
  public updateMemory(fact: { id: string; text: string; topic?: string; importance?: number }): Promise<unknown> {
    return this.rpc('memory.update', fact);
  }
  public deleteMemory(id: string): Promise<unknown> {
    return this.rpc('memory.delete', { id });
  }

  // ---- 插件集 Profile + Bundle ----
  public listProfiles(): Promise<Profile[]> {
    return this.rpc('profile.list', {});
  }
  public getActiveProfile(): Promise<ActivePlugins> {
    return this.rpc('profile.active', {});
  }
  public saveProfile(profile: { name: string; plugins: string[]; description: string }): Promise<unknown> {
    return this.rpc('profile.save', { profile });
  }
  public applyProfile(id: string): Promise<ProfileApplyResult> {
    return this.rpc('profile.apply', { id });
  }
  public deleteProfile(id: string): Promise<unknown> {
    return this.rpc('profile.delete', { id });
  }
  public packBundle(params: { id?: string; profile?: { name: string; plugins: string[] } }): Promise<BundlePackResult> {
    return this.rpc('bundle.pack', params);
  }
  public unpackBundle(zipPath: string): Promise<BundleUnpackResult> {
    return this.rpc('bundle.unpack', { zipPath });
  }

  // ---- 多 Agent 编排 ----
  public listGraphs(): Promise<GraphSummary[]> {
    return this.rpc('graph.list', {});
  }
  public getGraph(id: string): Promise<GraphGetResult> {
    return this.rpc('graph.get', { id });
  }
  public deleteGraph(id: string): Promise<unknown> {
    return this.rpc('graph.delete', { id });
  }
  public saveGraph(def: GraphDef): Promise<{ id: string }> {
    return this.rpc('graph.save', { def });
  }
  public runGraphById(id: string): Promise<GraphRunResult> {
    return this.rpc('graph.run', { id });
  }
  public runGraph(def: GraphDef): Promise<GraphRunResult> {
    return this.rpc('graph.run', { def });
  }
  public graphStatus(runId: string): Promise<GraphStatusResult> {
    return this.rpc('graph.status', { runId });
  }

  // ---- 工作台界面能力（上下文容量 / 配额 / 会话模式 / 权限档位 / 检索） ----
  // 一组 RPC 支撑三块 UI：上下文容量面板、输入区「+」添加菜单、权限档位面板。

  /** 上下文容量报告：六类 token 分解 + 窗口占比 + 提示缓存命中率。 */
  public contextUsage(threadId: string): Promise<import('../types/models.js').ContextUsageReport> {
    return this.rpc('context.usage', { threadId });
  }
  /** 当前模型与解析出的上下文窗口大小（容量面板标题用）。 */
  public contextWindow(): Promise<{ model: string; windowTokens: number }> {
    return this.rpc('context.window', {});
  }
  /** 今日余额（本地日内预算）× 各模型配额。 */
  public quotaGet(): Promise<import('../types/models.js').QuotaStatus> {
    return this.rpc('quota.get', {});
  }
  /** 调整配额档位与基础日预算。 */
  public quotaSet(patch: {
    plan?: string;
    dailyTokens?: number;
  }): Promise<import('../types/models.js').QuotaStatus> {
    return this.rpc('quota.set', patch);
  }
  /** 读当前会话的模式（目标 / 计划 / 绘图）。 */
  public modesGet(threadId: string): Promise<import('../types/models.js').SessionModes> {
    return this.rpc('modes.get', { threadId });
  }
  /** 更新会话模式；传空串 / false 即清除该项。 */
  public modesSet(
    threadId: string,
    patch: { goal?: string; planMode?: boolean; sketchMode?: boolean },
  ): Promise<import('../types/models.js').SessionModes> {
    return this.rpc('modes.set', { threadId, ...patch });
  }
  /** 审批档位表（后端单一来源，含描述与风险级别）。 */
  public approvalTiers(): Promise<{ tiers: import('../types/models.js').ApprovalTier[] }> {
    return this.rpc('approval.tiers', {});
  }
  /** 可选智能体清单（内置角色 + 编排图 + 插件）。 */
  public agentsList(): Promise<{ agents: import('../types/models.js').AgentCatalogEntry[] }> {
    return this.rpc('agents.list', {});
  }
  /** 一条查询同时搜工作区文件与历史会话。 */
  public searchAll(
    query: string,
    limit?: number,
  ): Promise<{ files: import('../types/models.js').SearchHit[]; chats: import('../types/models.js').SearchHit[] }> {
    return this.rpc('search.all', limit === undefined ? { query } : { query, limit });
  }
}
