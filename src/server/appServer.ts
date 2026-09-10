import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { LongTermMemoryPort, MemoryFact, MemoryFactPatch } from '../ports/longTermMemory.js';
import { WorkflowRunner } from '../autonomy/workflowRunner.js';
import type { WorkflowDef } from '../autonomy/workflowTypes.js';
import { CheckpointManager } from '../core/checkpoint.js';
import { GitWorkspaceSnapshot } from '../adapters/workspace/gitWorkspaceSnapshot.js';
import { JsonRpc } from './jsonRpc.js';
import type { ImageContent, FileAttachment } from '../ports/model.js';
import { id } from '../util/id.js';
import { AppServerHandlers } from './appServerHandlers.js';
import type { AppServerOptions, GraphRunState } from './appServerState.js';
import { PROVIDER_PRESETS } from './providerPresets.js';

export type { AppServerOptions } from './appServerState.js';

/** diff 行内评论记录（锚定 文件 + 行号 + 侧别），持久化在工作区 .omni/diff-comments.json。 */
interface DiffCommentRecord {
  id: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  text: string;
  ts: string;
}

/**
 * app-server：JSON-RPC 原语（threads/turns/items）+ 事件推送 + 审批上行。
 * 叶类：继承自 AppServerHandlers（→ AppServerBase），仅含构造器、方法调度与 graph/memory/线程/runGraph 处理器。
 */
export class AppServer extends AppServerHandlers {
  public constructor(options: AppServerOptions) {
    super(options);
    this.registerHandlers();
    options.transport.onMessage((message) => void this.handle(message));
    // 启动时异步探测一次当前 active 厂商（fire-and-forget，不阻塞 listen）。
    // 解决「页面刷新时模型下拉只有当前选中那一个」#OBS-4：探测拿到真实 /v1/models 后
    // 注入 probeCache，UI 重新拉 model.catalog 就能列出厂商全部模型。
    void this.warmActiveProvider();
  }

  /** 暖当前 active 厂商的 /v1/models 缓存。失败静默（probeCache 不被覆盖，UI 用兜底清单）。 */
  private async warmActiveProvider(): Promise<void> {
    try {
      // 只探测当前 active 厂商（按 baseUrl 严格匹配 → 否则按 modelAdapter 匹配第一个有 key 的预设），
      // 不全表扫 7 个厂商，避免启动慢、流量浪费。
      const file = this.effectiveFileConfig();
      const keys = file.providerKeys ?? {};
      const topKey = typeof file.apiKey === 'string' ? file.apiKey : undefined;
      const matched =
        PROVIDER_PRESETS.find(
          (p) => typeof file.baseUrl === 'string' && file.baseUrl === p.baseUrl,
        ) ??
        // 注意：必须要求该厂商在 providerKeys 或顶层 apiKey 中有 key，否则探测无意义（无凭据）。
        PROVIDER_PRESETS.find(
          (p) =>
            p.adapter === file.modelAdapter && (topKey !== undefined || keys[p.id] !== undefined),
        );
      const target = matched?.id;
      // 没匹配到厂商（纯 mock 或无凭据）就什么都不做，避免无意义探测。
      if (target === undefined) return;
      await this.probeModels({ provider: target });
    } catch {
      // 静默失败：探测走 HTTP，UI 后台再点「检测」按钮也能补。
    }
  }

  /** 注册方法处理。 */
  protected registerHandlers(): void {
    this.handlers.set('threads.create', (params) => this.createThread(params));
    this.handlers.set('threads.continue', (params) => this.continueThread(params));
    this.handlers.set('threads.fork', (params) => this.forkThread(params));
    this.handlers.set('threads.get', (params) => this.getThread(params));
    this.handlers.set('turns.run', (params) => this.runTurn(params));
    this.handlers.set('approval.respond', (params) => this.respondApproval(params));
    this.handlers.set('config.get', () => Promise.resolve(this.getConfig()));
    this.handlers.set('config.update', (params) => Promise.resolve(this.updateConfig(params)));
    this.handlers.set('model.catalog', () => Promise.resolve(this.modelCatalog()));
    this.handlers.set('model.probe', (params) => this.probeModels(params));
    this.handlers.set('usage.stats', () => Promise.resolve(this.usageStats()));
    this.handlers.set('workspace.list', () => Promise.resolve(this.listWorkspaces()));
    this.handlers.set('workspace.add', (params) =>
      Promise.resolve(this.addWorkspace(params['path'])),
    );
    this.handlers.set('workspace.switch', (params) =>
      Promise.resolve(this.switchWorkspace(params['path'])),
    );
    this.handlers.set('audit.query', (params) => Promise.resolve(this.queryAuditRpc(params)));
    this.registerCheckpointHandlers();
    this.registerReviewHandlers();
    this.handlers.set('fs.list', (params) => Promise.resolve(this.listFs(params)));
    this.handlers.set('fs.read', (params) => Promise.resolve(this.readFs(params)));
    this.handlers.set('sessions.list', async () => {
      const r = (await this.listSessions()) as {
        dir: string;
        sessions: { sessionId: string; running?: boolean }[];
      };
      // 真实运行态：runTurn 进入/退出维护 activeTurns，前端不再靠 mtime 猜测。
      return {
        dir: r.dir,
        sessions: r.sessions.map((s) => ({ ...s, running: this.activeTurns.has(s.sessionId) })),
      };
    });
    this.handlers.set('changes.list', (params) => Promise.resolve(this.listChanges(params)));
    this.handlers.set('fs.browse', (params) => Promise.resolve(this.browseFs(params)));
    this.handlers.set('fs.mkdir', (params) => Promise.resolve(this.mkdirFs(params)));
    this.handlers.set('attach.read', (params) => Promise.resolve(this.attachRead(params)));
    this.registerPluginHandlers();
    this.registerGraphHandlers();
    this.registerMemoryHandlers();
    this.registerProfileHandlers();
    this.registerBundleHandlers();
  }

  /** 多 Agent 编排 RPC（G-C，对标 codex agent-graph-store）：图增删查 + 运行 + 实时状态。 */
  protected registerGraphHandlers(): void {
    this.handlers.set('graph.list', async () => this.graphStoreOf().list());
    this.handlers.set('graph.get', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('graph.get 需要 id');
      }
      const def = this.graphStoreOf().get(idParam);
      if (def === undefined) {
        throw new Error('未找到图: ' + idParam);
      }
      return def;
    });
    this.handlers.set('graph.save', async (params) => {
      const def = params['def'];
      if (
        def === undefined ||
        typeof def !== 'object' ||
        !Array.isArray((def as Partial<WorkflowDef>).steps)
      ) {
        throw new Error('graph.save 需要 def（含 name 与 steps）');
      }
      const savedId = this.graphStoreOf().save(def as WorkflowDef);
      return { ok: true, id: savedId };
    });
    this.handlers.set('graph.delete', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('graph.delete 需要 id');
      }
      return { ok: this.graphStoreOf().delete(idParam) };
    });
    this.handlers.set('graph.run', async (params) => this.runGraph(params));
    this.handlers.set('graph.status', async (params) => {
      const runId = params['runId'];
      if (typeof runId !== 'string') {
        throw new Error('graph.status 需要 runId');
      }
      const run = this.graphRuns.get(runId);
      if (run === undefined) {
        throw new Error('未找到运行: ' + runId);
      }
      return {
        runId: run.runId,
        defId: run.defId,
        defName: run.defName,
        done: run.done,
        ok: run.ok,
        nodes: Object.values(run.nodes),
        blackboard: run.blackboard,
      };
    });
  }

  /** 会话检查点 / 回滚 RPC（对标 Codex「回滚到检查点」）：列表 / 创建 / 回滚（对话 + 代码）。 */
  private registerCheckpointHandlers(): void {
    this.handlers.set('checkpoint.list', (params) => this.listCheckpoints(params));
    this.handlers.set('checkpoint.create', (params) => this.createCheckpoint(params));
    this.handlers.set('checkpoint.rollback', (params) => this.rollbackCheckpoint(params));
  }

  /** 惰性构造检查点管理器：复用会话 StoragePort + Git 文件快照适配器。 */
  private checkpointManagerOf(): CheckpointManager {
    return new CheckpointManager(this.options.config.storage, {
      snapshotter: new GitWorkspaceSnapshot(),
      workspaceRoot: this.options.workspaceRoot ?? process.cwd(),
    });
  }

  private async listCheckpoints(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('checkpoint.list 需要 sessionId');
    }
    const list = await this.checkpointManagerOf().list(sessionId);
    return { sessionId, checkpoints: list };
  }

  private async createCheckpoint(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params['sessionId'];
    const label = params['label'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('checkpoint.create 需要 sessionId');
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error('checkpoint.create 需要 label');
    }
    const checkpoint = await this.checkpointManagerOf().snapshot(sessionId, label);
    return { ok: true, checkpoint };
  }

  private async rollbackCheckpoint(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('checkpoint.rollback 需要 sessionId');
    }
    const label = typeof params['label'] === 'string' ? (params['label'] as string) : undefined;
    const checkpoint = await this.checkpointManagerOf().rollback(sessionId, label);
    return { ok: true, checkpoint };
  }

  // ---- 内联 diff 审查（对标 Codex Review：hunk 级 stage/revert + 行内评论）----

  /** 注册 diff 审查 RPC：hunk/file 级 stage/revert（真实 git 操作）+ 行级评论（工作区级持久化）。 */
  private registerReviewHandlers(): void {
    this.handlers.set('changes.stageFile', (params) => Promise.resolve(this.changeStageFile(params)));
    this.handlers.set('changes.revertFile', (params) => Promise.resolve(this.changeRevertFile(params)));
    this.handlers.set('changes.stageHunk', (params) => Promise.resolve(this.changeStageHunk(params)));
    this.handlers.set('changes.revertHunk', (params) => Promise.resolve(this.changeRevertHunk(params)));
    this.handlers.set('changes.comments.list', () => Promise.resolve(this.listDiffComments()));
    this.handlers.set('changes.comments.add', (params) => Promise.resolve(this.addDiffComment(params)));
    this.handlers.set('changes.comments.delete', (params) =>
      Promise.resolve(this.deleteDiffComment(params)),
    );
  }

  /** 校验当前工作区为 git 仓库，返回工作区根（否则 fail-closed 抛错）。 */
  private gitWorkspaceOrFail(): string {
    const ws = this.effectiveWorkspace();
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ws,
      encoding: 'utf8',
    });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
      throw new Error('当前工作区不是 git 仓库，无法执行 stage/revert');
    }
    return ws;
  }

  /** 路径安全校验：仅接受仓库内相对路径（拒绝绝对路径与 .. 穿越），返回规范化相对路径。 */
  private safeRepoPath(ws: string, raw: string): string {
    if (raw.length === 0) throw new Error('path 不能为空');
    if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error('仅接受仓库内相对路径');
    const abs = resolve(ws, raw);
    const rel = relative(ws, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.length === 0) {
      throw new Error('路径越出仓库范围：' + raw);
    }
    return rel;
  }

  /** 单 hunk 补丁文本：`--- a/…` / `+++ b/…` 文件头 + hunk（@@ 行与正文）。 */
  private hunkPatchText(rel: string, hunk: string): string {
    if (!hunk.includes('@@')) throw new Error('hunk 文本缺少 @@ 头');
    return `--- a/${rel}\n+++ b/${rel}\n${hunk.replace(/\n+$/, '')}\n`;
  }

  /** 指定文件的两字符 porcelain 状态（?? / A / M / D / R…），仓库异常返回 ''。 */
  private fileStatus(ws: string, rel: string): string {
    const st = spawnSync('git', ['status', '--porcelain', '--', rel], {
      cwd: ws,
      encoding: 'utf8',
    });
    return st.status === 0 ? st.stdout.slice(0, 2).trim() : '';
  }

  /** stage 整个文件（含未跟踪新文件）：`git add -- path`。 */
  private changeStageFile(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    if (typeof raw !== 'string') throw new Error('changes.stageFile 需要 path');
    const ws = this.gitWorkspaceOrFail();
    const rel = this.safeRepoPath(ws, raw);
    const add = spawnSync('git', ['add', '--', rel], { cwd: ws, encoding: 'utf8' });
    if (add.status !== 0) {
      throw new Error('git add 失败：' + (add.stderr || add.stdout).trim());
    }
    return { ok: true };
  }

  /** 丢弃整个文件的工作区改动（还原到 index 版本）；未跟踪文件拒绝服务端删除（防误删）。 */
  private changeRevertFile(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    if (typeof raw !== 'string') throw new Error('changes.revertFile 需要 path');
    const ws = this.gitWorkspaceOrFail();
    const rel = this.safeRepoPath(ws, raw);
    if (this.fileStatus(ws, rel) === '??') {
      throw new Error('未跟踪文件不做服务端丢弃（防误删），请手动删除或先 stage');
    }
    const co = spawnSync('git', ['checkout', '--', rel], { cwd: ws, encoding: 'utf8' });
    if (co.status !== 0) {
      throw new Error('git checkout 失败：' + (co.stderr || co.stdout).trim());
    }
    return { ok: true };
  }

  /** stage 单个 hunk：`git apply --cached`。未跟踪新文件先 `git add -N` 建立意向项。 */
  private changeStageHunk(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    const hunk = params['hunk'];
    if (typeof raw !== 'string') throw new Error('changes.stageHunk 需要 path');
    if (typeof hunk !== 'string' || hunk.trim() === '') {
      throw new Error('changes.stageHunk 需要 hunk 文本');
    }
    const ws = this.gitWorkspaceOrFail();
    const rel = this.safeRepoPath(ws, raw);
    if (params['isNew'] === true) {
      // 未跟踪文件先进 index 意向区（intent-to-add），否则 --cached apply 无目标。
      const addN = spawnSync('git', ['add', '-N', '--', rel], { cwd: ws, encoding: 'utf8' });
      if (addN.status !== 0) {
        throw new Error('git add -N 失败：' + (addN.stderr || addN.stdout).trim());
      }
    }
    const apply = spawnSync(
      'git',
      ['apply', '--cached', '--recount', '--whitespace=nofix', '-'],
      { cwd: ws, encoding: 'utf8', input: this.hunkPatchText(rel, hunk) },
    );
    if (apply.status !== 0) {
      throw new Error('git apply --cached 失败：' + (apply.stderr || apply.stdout).trim());
    }
    return { ok: true };
  }

  /** 丢弃单个 hunk 的工作区改动：`git apply -R`（反向应用于工作树）。 */
  private changeRevertHunk(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    const hunk = params['hunk'];
    if (typeof raw !== 'string') throw new Error('changes.revertHunk 需要 path');
    if (typeof hunk !== 'string' || hunk.trim() === '') {
      throw new Error('changes.revertHunk 需要 hunk 文本');
    }
    const ws = this.gitWorkspaceOrFail();
    const rel = this.safeRepoPath(ws, raw);
    const apply = spawnSync('git', ['apply', '-R', '--recount', '--whitespace=nofix', '-'], {
      cwd: ws,
      encoding: 'utf8',
      input: this.hunkPatchText(rel, hunk),
    });
    if (apply.status !== 0) {
      throw new Error('git apply -R 失败：' + (apply.stderr || apply.stdout).trim());
    }
    return { ok: true };
  }

  /** 行内评论持久化文件（工作区级，与 .omni-checkpoints 同一约定：藏在 .omni/ 下）。 */
  private diffCommentsFile(): string {
    return join(this.effectiveWorkspace(), '.omni', 'diff-comments.json');
  }

  /** 读取全部行内评论；文件缺失/损坏返回空数组（fail-open 到空态，不阻断 UI）。 */
  private loadDiffComments(): DiffCommentRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.diffCommentsFile(), 'utf8'));
      if (!Array.isArray(parsed)) return [];
      const out: DiffCommentRecord[] = [];
      for (const item of parsed) {
        const c = item as Partial<DiffCommentRecord>;
        if (
          typeof c.id === 'string' &&
          typeof c.path === 'string' &&
          (c.side === 'old' || c.side === 'new') &&
          typeof c.line === 'number' &&
          typeof c.text === 'string' &&
          typeof c.ts === 'string'
        ) {
          out.push({ id: c.id, path: c.path, side: c.side, line: c.line, text: c.text, ts: c.ts });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private saveDiffComments(list: readonly DiffCommentRecord[]): void {
    const file = this.diffCommentsFile();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  }

  private listDiffComments(): unknown {
    return { comments: this.loadDiffComments() };
  }

  private addDiffComment(params: Record<string, unknown>): unknown {
    const rawPath = params['path'];
    const text = params['text'];
    const line = params['line'];
    if (typeof rawPath !== 'string' || typeof text !== 'string' || text.trim() === '') {
      throw new Error('changes.comments.add 需要非空 path 与 text');
    }
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
      throw new Error('changes.comments.add 需要非负整数 line');
    }
    const side = params['side'] === 'old' ? 'old' : 'new';
    const ws = this.effectiveWorkspace();
    const rel = this.safeRepoPath(ws, rawPath);
    const comment: DiffCommentRecord = {
      id: id('cmt'),
      path: rel,
      side,
      line,
      text: text.trim(),
      ts: new Date().toISOString(),
    };
    const list = this.loadDiffComments();
    list.push(comment);
    this.saveDiffComments(list);
    return { ok: true, comment };
  }

  private deleteDiffComment(params: Record<string, unknown>): unknown {
    const idParam = params['id'];
    if (typeof idParam !== 'string') throw new Error('changes.comments.delete 需要 id');
    const list = this.loadDiffComments();
    const next = list.filter((c) => c.id !== idParam);
    if (next.length === list.length) {
      throw new Error('未找到评论: ' + idParam);
    }
    this.saveDiffComments(next);
    return { ok: true };
  }

  /** 长期记忆管理 RPC（#G-D / 4.3，对标 codex dedicated memories）：列表/查看/增/改/删/检索 + 变更实时通知。 */
  protected registerMemoryHandlers(): void {
    const store = (): LongTermMemoryPort => this.options.config.longTermMemory;
    this.handlers.set('memory.list', async () => {
      const facts = store().all();
      return { count: facts.length, facts: facts.map((f) => ({ ...f })) };
    });
    this.handlers.set('memory.get', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('memory.get 需要 id');
      }
      const fact = store().get(idParam);
      if (fact === undefined) {
        throw new Error('未找到记忆: ' + idParam);
      }
      return { ...fact };
    });
    this.handlers.set('memory.add', async (params) => {
      const text = params['text'];
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('memory.add 需要非空 text');
      }
      const topic = typeof params['topic'] === 'string' ? (params['topic'] as string) : undefined;
      const rawImp = typeof params['importance'] === 'number' ? params['importance'] : 3;
      const importance = Math.min(5, Math.max(1, Math.round(rawImp)));
      const fact: MemoryFact = {
        id: id('mem'),
        text: text.trim(),
        topic,
        importance,
        createdAt: new Date().toISOString(),
        sessionId: 'ui-manual',
        source: 'tool',
      };
      store().remember(fact);
      this.options.transport.send(JsonRpc.notify('memory.changed', {}));
      return { ok: true, id: fact.id };
    });
    this.handlers.set('memory.update', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('memory.update 需要 id');
      }
      const patch: MemoryFactPatch = {};
      if (typeof params['text'] === 'string') patch.text = params['text'];
      if (typeof params['topic'] === 'string') patch.topic = params['topic'];
      if (typeof params['importance'] === 'number') patch.importance = params['importance'];
      const ok = store().update(idParam, patch);
      if (!ok) {
        throw new Error('未找到记忆: ' + idParam);
      }
      this.options.transport.send(JsonRpc.notify('memory.changed', {}));
      return { ok: true };
    });
    this.handlers.set('memory.delete', async (params) => {
      const idParam = params['id'];
      if (typeof idParam !== 'string' || idParam.length === 0) {
        throw new Error('memory.delete 需要 id');
      }
      const ok = store().delete(idParam);
      if (!ok) {
        throw new Error('未找到记忆: ' + idParam);
      }
      this.options.transport.send(JsonRpc.notify('memory.changed', {}));
      return { ok: true };
    });
    this.handlers.set('memory.search', async (params) => {
      const query = params['query'];
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('memory.search 需要非空 query');
      }
      const limit =
        typeof params['limit'] === 'number'
          ? Math.max(1, Math.floor(params['limit'] as number))
          : 5;
      const hits = store().recall(query, limit);
      return {
        count: hits.length,
        results: hits.map((fact) => ({
          id: fact.id,
          topic: fact.topic,
          text: fact.text,
          importance: fact.importance,
        })),
      };
    });
  }

  /** 创建线程。 */
  protected async createThread(params: Record<string, unknown>): Promise<unknown> {
    const result = await this.agentInstance().runTask(String(params['prompt'] ?? ''));
    this.threads.set(result.sessionId, result.sessionId);
    return this.threadResult(result);
  }

  /** 续跑线程。 */
  protected async continueThread(params: Record<string, unknown>): Promise<unknown> {
    const result = await this.agentInstance().resume(
      String(params['threadId'] ?? ''),
      String(params['prompt'] ?? ''),
    );
    this.threads.set(result.sessionId, result.sessionId);
    return this.threadResult(result);
  }

  /** 分叉线程。 */
  protected async forkThread(params: Record<string, unknown>): Promise<unknown> {
    const result = await this.agentInstance().fork(
      String(params['threadId'] ?? ''),
      String(params['prompt'] ?? ''),
    );
    this.threads.set(result.sessionId, result.sessionId);
    return this.threadResult(result);
  }

  /** 获取线程事件。 */
  protected async getThread(params: Record<string, unknown>): Promise<unknown> {
    const threadId = String(params['threadId'] ?? '');
    const items = await this.agentInstance().replay(threadId);
    return { threadId, items };
  }

  /** 运行回合（线程已存在则续跑）。images 可选，随首条用户消息送入模型（#B1）。 */
  protected async runTurn(params: Record<string, unknown>): Promise<unknown> {
    const threadId = String(params['threadId'] ?? '');
    const prompt = String(params['prompt'] ?? '');
    const images = params['images'] as readonly ImageContent[] | undefined;
    const files = params['files'] as readonly FileAttachment[] | undefined;
    // 真实运行态跟踪：并行任务卡据此显示「运行中」，而非前端猜测。
    this.activeTurns.add(threadId);
    try {
      const result = this.threads.has(threadId)
        ? await this.agentInstance().resume(threadId, prompt, images, files)
        : await this.agentInstance().runTask(prompt, images, files);
      this.threads.set(result.sessionId, result.sessionId);
      return this.threadResult(result);
    } finally {
      this.activeTurns.delete(threadId);
    }
  }

  /** 响应审批上行。 */
  protected async respondApproval(params: Record<string, unknown>): Promise<unknown> {
    const requestId = String(params['requestId'] ?? '');
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve !== undefined) {
      resolve(params['decision'] === 'allow' ? 'allow' : 'deny');
      this.pendingApprovals.delete(requestId);
    }
    return { ok: true };
  }

  /**
   * 异步运行图（DAG 编排）：立即返回 runId，节点状态经 graph.progress 通知实时推送，
   * 结束经 graph.done 通知。运行态存于 graphRuns 供 graph.status 查询。
   */
  protected runGraph(params: Record<string, unknown>): { runId: string; nodeCount: number } {
    const store = this.graphStoreOf();
    let def: WorkflowDef | undefined;
    const idParam = typeof params['id'] === 'string' ? params['id'] : undefined;
    const defArg = params['def'];
    if (idParam !== undefined) {
      def = store.get(idParam);
      if (def === undefined) {
        throw new Error('未找到图: ' + idParam);
      }
    } else if (
      defArg !== undefined &&
      typeof defArg === 'object' &&
      Array.isArray((defArg as Partial<WorkflowDef>).steps)
    ) {
      def = defArg as WorkflowDef;
    } else {
      throw new Error('graph.run 需要 id（已存图）或 def（内联定义）');
    }

    const runId = id('run');
    const runState: GraphRunState = {
      runId,
      defId: idParam,
      defName: def.name,
      nodes: {},
      done: false,
      startedAt: Date.now(),
    };
    for (const step of def.steps) {
      runState.nodes[step.id] = { id: step.id, status: 'pending' };
    }
    this.graphRuns.set(runId, runState);

    const ports = this.graphPortsOf();
    void new WorkflowRunner(ports, {
      maxConcurrency: def.maxConcurrency,
      onNodeUpdate: (update) => {
        const node = runState.nodes[update.id];
        if (node !== undefined) {
          node.status = update.status;
          node.error = update.error;
          node.steps = update.steps;
          node.durationMs = update.durationMs;
        }
        this.options.transport.send(JsonRpc.notify('graph.progress', { runId, ...update }));
      },
    })
      .run(def)
      .then((result) => {
        runState.done = true;
        runState.ok = result.ok;
        runState.blackboard = result.blackboard;
        this.options.transport.send(
          JsonRpc.notify('graph.done', {
            runId,
            ok: result.ok,
            blackboard: { ...result.blackboard },
          }),
        );
      })
      .catch((error: unknown) => {
        runState.done = true;
        runState.ok = false;
        this.options.transport.send(
          JsonRpc.notify('graph.done', { runId, ok: false, error: this.messageOf(error) }),
        );
      });

    return { runId, nodeCount: def.steps.length };
  }
}
