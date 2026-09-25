import type { SessionEvent } from '../ports/runtime/event.js';
import type { ModelMessage } from '../ports/model/model.js';
import type { ToolDefinition } from '../ports/tool/tool.js';
import { ContextAssembler } from '../context/contextAssembler.js';
import { ProjectInstructions } from '../context/projectInstructions.js';
import { type CompactionState, ContextCompactor } from '../context/contextCompactor.js';
import type { StepRunnerDeps } from './stepTypes.js';
import { ToolExposurePlanner } from './toolExposurePlanner.js';
import { log } from '../util/logger.js';
import { ArrayAt } from '../util/arrayAt.js';

/**
 * P5 自动降档时的载荷形态（`payloadShape`）——**只保留 Top-1 的完整符号大纲**，其余命中文件
 * 降为「📄 路径」一行（见 `RepoMapPayload.DEGRADE_PLAN`）。
 *
 * 为什么降档改缩「大纲档位」而非「文件数」（2026-09-17 改）：注入 token 的大头是**前几档的
 * 完整符号大纲**（每文件数百 token），尾部路径行每行仅约 7 token。实测梯度投送下 fileK 5→10
 * 的 token 只差 34（1030 → 1064），命中率却差 **18.1pp**（36.4% → 54.5%）——即「缩文件数」
 * 几乎不省 token 却大损召回。改缩大纲档位后（K=14 档）：**946 token**（比旧降档档位 fileK=5 的
 * 1337 还少 **29%**），而命中率 **69.7%**（旧降档 36.4%，**+33.3pp**）——因为**选中文件集合
 * 完全不变**（构造性保证），只是呈现变薄。报告：`evals/military-payload-ab.report.json`。
 */
const DEGRADE_PAYLOAD_SHAPE = 'degrade' as const;

/**
 * 单步「上下文组装」协作者（从 `StepRunner` 按职责缝抽出，P6.3 上帝类收口）。
 *
 * 职责单一：把事件日志投影成发给模型的消息列表，并把本轮可见工具集算出来。
 * 具体包括三件事——
 *  1. 常驻指令（AGENTS.md / CLAUDE.md / llms.txt）注入；
 *  2. repo-map 上下文推导与注入（纯 BM25 或 混合检索）；
 *  3. 上下文压缩与**压缩游标**的跨步复用 / 崩溃恢复（旧缺陷「压缩结果瞬态、每步重复调摘要 LLM」的修复点，审计 P0-1）。
 *
 * 全部外部读取失败一律 fail-closed（跳过该片段），绝不因上下文增强而阻断主流程。
 */
export class StepContextBuilder {
  /** 消息投影器：把事件日志按角色投影为模型消息列表（注入额外 system 片段）。 */
  private readonly assembler: ContextAssembler;
  /**
   * 压缩状态游标（V2）：内存持有跨步复用，写回事件日志供崩溃恢复。
   * 消灭旧缺陷「压缩结果瞬态、每步重复调摘要 LLM」（审计 P0-1）。
   */
  private compactionState: CompactionState | undefined;
  /** 是否已尝试从事件日志恢复压缩游标（懒恢复，只做一次）。 */
  private stateRestored = false;

  /**
   * @param deps 单步依赖契约（此处消费上下文相关字段：recorder / compactor / fragments /
   *   workspaceRoot / repoMapEnabled / embedding / projectInstructionsEnabled）。
   */
  public constructor(private readonly deps: StepRunnerDeps) {
    this.assembler = new ContextAssembler(deps.fragments);
  }

  /**
   * 组装模型消息（按需压缩，注入常驻指令与 repo-map）。
   *
   * 消息排序（前缀缓存友好，P_prefix 治理）：
   *   `world_state`（固定碎片）→ 常驻指令（AGENTS.md，同一工作区静态）→ 事件历史 →
   *   **repo-map（尾部动态段）**。
   * 常驻指令与事件历史跨回合稳定，仅尾部 repo-map 每轮随查询变化 ⇒ provider 前缀缓存命中率
   * 从 ~54% 升至 ~81%（受控对照实测，见 `docs/TASK_BOARD.md` 第 22 条）。repo-map 内容不变，
   * 仅从「事件历史之前」移到「之后」——纯缓存优化，零信息损失、默认部署零行为变更。
   *
   * @returns 投影 + 压缩后发给模型的消息列表（跨步复用压缩游标）。
   */
  public async buildMessages(): Promise<readonly ModelMessage[]> {
    const events = this.deps.recorder.allEvents();
    const frontFragments: string[] = [];
    // 常驻指令（静态：同一工作区内容稳定）放头部，构成稳定前缀缓存锚点，先于动态派生信息。
    // 任何读取/解析失败均 fail-closed（返回 null 即跳过），绝不因指令文件问题阻断主流程。
    if (this.deps.workspaceRoot !== undefined && this.deps.projectInstructionsEnabled !== false) {
      const instructions = await ProjectInstructions.loadProjectInstructionsCached({
        workspaceRoot: this.deps.workspaceRoot,
      });
      if (instructions !== null) {
        frontFragments.push(instructions.content);
      }
    }
    // U2：repo-map 是逐轮变化的动态段（查询派生），先计算、后置于消息尾部——见方法 JSDoc 排序说明。
    // 若注入了语义嵌入端口则走混合检索（BM25 ∪ 语义 RRF），否则纯 BM25（零开销）；任何失败 fail-closed。
    let repoMap: string | null = null;
    if (this.deps.workspaceRoot !== undefined && this.deps.repoMapEnabled !== false) {
      const q = this.deriveQueryText(events);
      if (q !== '') {
        repoMap = await this.buildRepoMapContext(q);
      }
    }
    const projected = this.assembler.build(events, frontFragments);
    const compactor = this.deps.compactor;
    let messages: ModelMessage[];
    if (compactor === undefined) {
      messages = projected;
    } else {
      // V2：懒恢复压缩游标（进程重启/resume 后从事件日志解析最近压缩点，只做一次）。
      if (!this.stateRestored) {
        this.stateRestored = true;
        this.compactionState = this.restoreCompactionState(events);
      }
      const previous = this.compactionState;
      const result = await compactor.compact(projected, previous);
      if (result.state !== undefined) {
        // 游标持久化：写回事件日志（system 事件），崩溃/重启后可恢复，跨步复用摘要。
        //
        // **只在游标变化时写回**：压缩快路径每步都返回**同一个** state，无条件写回会让同一份
        // `OMNI_COMPACTION_V1`（正文即全文摘要）在长会话里逐步骤增——实测第 4 步的请求体里
        // 已含 4 份摘要副本 + 3 行内部游标标记，白烧 prompt token 并稀释注意力。
        // 恢复只认**最后一条**标记（见 {@link restoreCompactionState}），少写不影响崩溃恢复。
        this.compactionState = result.state;
        if (
          previous === undefined ||
          ContextCompactor.encodeCompactionState(previous) !==
            ContextCompactor.encodeCompactionState(result.state)
        ) {
          this.deps.recorder.system(ContextCompactor.encodeCompactionState(result.state));
        }
      } else if (result.compacted && previous === undefined) {
        // 无游标路径（head 为空的退化压缩）：维持旧行为的提示文本（仅首次，避免每步重复）。
        this.deps.recorder.system(
          `上下文压缩: 已折叠较早历史（摘要 ${result.summary?.length ?? 0} 字）`,
        );
      }
      // 注：原先还有一支 `compacted && 游标已存在` 的「复用既有摘要」提示——它每步都写一条
      // 内容相同的 system 事件，是纯粹的逐步骤增噪声（压缩是否发生已由游标事件与 model 快照体现），
      // 故删除该分支。
      messages = [...result.messages];
    }
    // 动态段（repo-map）置于尾部：前置（world_state + 常驻指令 + 事件历史）跨回合稳定，
    // 仅尾部每轮变化 ⇒ 命中 provider 前缀缓存。内容不变、仅位置后移（P_prefix 治理）。
    if (repoMap !== null) {
      messages.push({ role: 'system', content: repoMap });
    }
    return messages;
  }

  /**
   * 发给模型的工具集：直载（listDirect，剔除 deferred）∪ 经 tool_search 发现的延迟加载工具。
   * 按名去重：被发现的工具补充进上下文，使其可被模型真正调用（#M1 延迟加载闭环）。
   *
   * **按需暴露（`OMNI_TOOL_EXPOSURE=plan`，默认关）**：开启后先经 {@link ToolExposurePlanner}
   * 按本轮任务文本判类别相关性，把明显不相关的类别整体降为延迟加载——动机与安全方向见该模块头
   * （Laya 高基数实测：每选项 token 预算即准确率天花板）。三条不可动摇的护栏：
   *   - **被 `tool_search` 发现的工具恒可见**（模型已明确表达需要，不得反悔）；
   *   - **未登记类别的工具恒可见** + **无类别命中即全部可见**（fail-safe，宁多给不少给）；
   *   - **默认 `off` ⇒ 与接线前逐字等价**（零行为变更）。
   * 被延迟的工具并未丢失：`ToolIndex` 建自 `registry.list()`（全部工具），可经 `tool_search` 找回。
   *
   * @returns 去重后的工具定义列表（直载项优先，发现的同名项被丢弃）。
   */
  public effectiveTools(): ToolDefinition[] {
    const direct = this.deps.tools.listDirect?.() ?? this.deps.tools.list();
    const discovered = this.deps.discovery?.list() ?? [];
    const exposed = this.exposeByRelevance(direct);
    const byName = new Map<string, ToolDefinition>();
    for (const tool of exposed) {
      byName.set(tool.name, tool);
    }
    // 已发现的工具保留：模型已经检索过它们，隐藏会直接打断 #M1 闭环。
    // (D4) 但**必须绑定当前工具目录快照**：`ToolDiscovery` 只是按名累积的寄存器，插件/工具在
    // 会话中途卸载（`RegistryToolPort.unregister`，插件热卸载路径）后，它仍持有陈旧 schema；
    // 若无条件并入，模型会拿到一个**已不存在的工具**并调用它 ⇒ 必然失败。
    // 契约：**能核对才绑定，不能核对不丢能力**——
    //   · 目录可查 ⇒ 以目录为准：目录里没有的丢弃；仍在的取目录中的最新定义（不用陈旧副本）；
    //   · 目录不可查（`list` 缺失）⇒ 无从判定陈旧与否，保持既有行为（并入寄存器内容），
    //     否则会在一个无法核实的场景下把 #M1 闭环整体打断。
    const catalog = this.deps.tools.list?.();
    const live =
      catalog === undefined
        ? undefined
        : new Map<string, ToolDefinition>(catalog.map((tool) => [tool.name, tool]));
    for (const tool of discovered) {
      if (byName.has(tool.name)) {
        continue;
      }
      if (live === undefined) {
        byName.set(tool.name, tool);
        continue;
      }
      const current = live.get(tool.name);
      if (current !== undefined) {
        byName.set(tool.name, current);
      }
    }
    return [...byName.values()];
  }

  /**
   * 按相关性裁剪直载工具（`OMNI_TOOL_EXPOSURE=plan` 时生效；否则原样返回）。
   *
   * 任务文本复用 repo-map 的同一推导（最近至多 3 条 user 消息），**不额外读状态**，
   * 保证同一回合内 repo-map 与工具暴露看到的是同一个查询。
   *
   * @param direct 直载工具定义列表。
   * @returns 裁剪后的工具定义列表（默认 `off` 时与入参同一数组，零成本）。
   */
  private exposeByRelevance(direct: readonly ToolDefinition[]): readonly ToolDefinition[] {
    if (ToolExposurePlanner.modeFromEnv() !== 'plan') return direct;
    const plan = ToolExposurePlanner.plan({
      taskText: this.deriveQueryText(this.deps.recorder.allEvents()),
      tools: direct.map((tool) => tool.name),
    });
    if (plan.deferred.length === 0) return direct;
    const keep = new Set(plan.visible);
    return direct.filter((tool) => keep.has(tool.name));
  }

  /**
   * 从事件日志推导 repo-map 查询文本：取最近最多 3 条 user 消息的 content 拼接。
   * 仅用 user 文本（避开工具结果噪声），足以驱动 repo-map 的相关文件召回。
   *
   * @param events 会话事件日志（倒序扫描，取最近 3 条 user 文本）。
   * @returns 按时间正序拼接的查询文本；无 user 文本时为空串。
   */
  private deriveQueryText(events: readonly SessionEvent[]): string {
    const texts: string[] = [];
    for (let i = events.length - 1; i >= 0 && texts.length < 3; i--) {
      const e = ArrayAt.at(events, i);
      if (e.type === 'user') {
        const content = (e.payload as { content?: string }).content;
        if (content !== undefined && content.trim() !== '') {
          texts.push(content.trim());
        }
      }
    }
    return texts.reverse().join('\n');
  }

  /**
   * 从事件日志恢复最近一次压缩游标（倒序扫描 system 事件，fail-closed：
   * 格式不符/无压缩点均返回 undefined，走正常压缩路径）。
   *
   * @param events 会话事件日志。
   * @returns 最近一次压缩游标；不存在或格式不符时为 undefined。
   */
  private restoreCompactionState(events: readonly SessionEvent[]): CompactionState | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = ArrayAt.at(events, i);
      if (e.type !== 'system') {
        continue;
      }
      const content = (e.payload as { content?: string }).content;
      if (typeof content !== 'string' || !content.startsWith('OMNI_COMPACTION_V1')) {
        continue;
      }
      return ContextCompactor.decodeCompactionState(content);
    }
    return undefined;
  }

  /**
   * 推导并产出 repo-map 上下文（BM25 或混合检索）。
   * 任一路径失败均返回 null（fail-closed），不影响主流程。
   *
   * P5 自动降档：当预算降级信号置位（`budgetDegrade.shouldDegrade` 为真，即软阈值已越过、
   * 硬预算尚未熔断）时，**强制纯 BM25**（忽略语义嵌入端口）、**收缩载荷大纲档位**（
   * `payloadShape: 'degrade'`，只留 Top-1 完整大纲）并关闭第二段词法重排，直接压低注入上下文的
   * token 量。无信号（默认部署 / 未越软阈值 / 已熔断）时保持生产检索口径，不再额外降档。
   * 注：降档改缩「大纲档位」而非「文件数」的依据见 {@link DEGRADE_PAYLOAD_SHAPE}；
   * 文件预算本身维持生产默认 20（见 `repoMapContextEngine.DEFAULT_FILE_K`）——因为尾部路径行
   * 几乎不占 token，缩它只损召回不省成本。
   *
   * @param q 由最近 user 消息推导出的查询文本（非空）。
   * @returns repo-map 上下文片段；不可用时为 null。
   */
  private async buildRepoMapContext(q: string): Promise<string | null> {
    const root = this.deps.workspaceRoot!;
    const engine = this.deps.repoMapContext;
    const degrade = this.deps.budgetDegrade?.shouldDegrade === true;
    if (degrade) {
      // (L6) 降档是**决策**，必须带可读理由落观测——否则事后只能看到「档位变了」，
      // 无从判断是预算越阈、检索退化还是配置变更导致（借鉴 Laya `router.route(x).reason`）。
      log.info('context.repomap.degrade', {
        reason: '软预算已越阈（budgetDegrade.shouldDegrade=true）',
        effect: `纯 BM25（忽略 embedding）+ 关重排 + 收缩大纲档位（payloadShape=${DEGRADE_PAYLOAD_SHAPE}）`,
        queryChars: q.length,
      });
      // 降级：纯 BM25 + 收缩大纲档位 + 关重排（即便注入过 embedding 也强制落在零开销词法路）。
      return engine.getRepoMapContext(root, q, {
        rerank: false,
        payloadShape: DEGRADE_PAYLOAD_SHAPE,
      });
    }
    if (this.deps.embedding !== undefined) {
      try {
        return await engine.getHybridRepoMapContext(root, q, this.deps.embedding);
      } catch {
        // 混合检索异常 → 回落纯 BM25（不应发生，getHybridRepoMapContext 自身已 fail-closed，双保险）。
        return engine.getRepoMapContext(root, q);
      }
    }
    return engine.getRepoMapContext(root, q);
  }
}
