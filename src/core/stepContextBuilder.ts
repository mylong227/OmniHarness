import type { SessionEvent } from '../ports/runtime/event.ts';
import type { ModelMessage } from '../ports/model/model.ts';
import type { ToolDefinition } from '../ports/tool/tool.ts';
import { ContextAssembler } from '../context/contextAssembler.ts';
import { ContextShapers } from '../context/contextShapers.ts';
import { PrefixStability } from '../context/prefixStability.ts';
import { ProjectInstructions } from '../context/projectInstructions.ts';
import { type CompactionState, ContextCompactor } from '../context/contextCompactor.ts';
import type { RequestOverhead } from '../context/contextCompactor.ts';
import type { StepRunnerDeps } from './stepTypes.ts';
import { ToolExposurePlanner } from './toolExposurePlanner.ts';
import { log } from '../util/logger.ts';
import { ArrayAt } from '../util/arrayAt.ts';

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
  /** 上一次请求的序列化文本（前缀复用率测量的比对基准；G1b-b）。 */
  private lastSerialized: string | undefined;
  /** 上一次组装测得的相邻请求前缀复用率（0–1）；首次请求无基准 ⇒ undefined。 */
  private lastPrefixReuseRatio: number | undefined;
  /**
   * 上一步被**延迟加载**的工具名（按名字升序；空数组 = 本轮没有工具被隐藏）。
   *
   * 存在意义：`tool_search` 虽是唯一找回入口，但模型**不知道自己缺什么**时不会去搜。
   * 2026-10-19 鹈鹕会话实测：`write_file` 被延迟，模型先用 `run_code` + `node -e` 写文件
   * 连撞 5 次沙箱拒绝，直到第 427 秒才想起 `tool_search`——白烧 5.5 分钟。把「本轮没给你哪些
   * 工具」一句话写进上下文，模型就能在**第一步**直接 `tool_search`，而不是盲试。
   */
  private lastDeferredTools: readonly string[] = [];
  /** 消息对象 → 它的 JSON 片段（前缀复用测量用；WeakMap 随消息对象一起回收）。 */
  private readonly serializedMessages = new WeakMap<object, string>();

  /**
   * @param deps 单步依赖契约（此处消费上下文相关字段：recorder / compactor / fragments /
   *   workspaceRoot / repoMapEnabled / embedding / projectInstructionsEnabled）。
   */
  public constructor(private readonly deps: StepRunnerDeps) {
    this.assembler = new ContextAssembler(deps.fragments, deps.attachmentRoot);
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
   * @param overhead 每请求固定开销（本轮可见工具 schema + repo-map 尾段）。
   *   **给了才进预算**：不传即与改造前逐字一致（工具/schema 与尾段都不入账）。
   *   调用方（`StepRunner.requestModel`）先算工具集再调本方法，正是为了把这份开销交进来——
   *   否则长会话会「越过真实窗口才触发压缩」（fail-open 到上游 400）。
   * @param forceCompaction 为 true 时强制压缩（LR-03：端点已报 prompt-too-long，主动压缩后重试）。
   * @returns 投影 + 压缩后发给模型的消息列表（跨步复用压缩游标）。
   */
  public async buildMessages(
    overhead?: RequestOverhead,
    forceCompaction = false,
  ): Promise<readonly ModelMessage[]> {
    const events = this.deps.recorder.allEvents();
    // 常驻指令（静态）放头部，构成稳定前缀缓存锚点；读取失败 fail-closed（返回空）。
    const frontFragments = await this.projectInstructionFragments();
    // U2：repo-map 是逐轮变化的动态段（查询派生），先计算、后置于消息尾部——见方法 JSDoc 排序说明。
    // 若注入了语义嵌入端口则走混合检索（BM25 ∪ 语义 RRF），否则纯 BM25（零开销）；任何失败 fail-closed。
    let repoMap: string | null = null;
    if (this.deps.workspaceRoot !== undefined && this.deps.repoMapEnabled !== false) {
      const q = this.deriveQueryText(events);
      if (q !== '' && StepContextBuilder.shouldBuildRepoMap(q)) {
        repoMap = await this.buildRepoMapContext(q);
      }
    }
    const projected = this.assembler.build(events, frontFragments);
    const projectedForModel = this.shapeIfEnabled(projected, forceCompaction);
    const compactor = this.deps.compactor;
    let messages: ModelMessage[];
    if (compactor === undefined) {
      messages = [...projectedForModel];
    } else {
      // V2：懒恢复压缩游标（进程重启/resume 后从事件日志解析最近压缩点，只做一次）。
      if (!this.stateRestored) {
        this.stateRestored = true;
        this.compactionState = this.restoreCompactionState(events);
      }
      const previous = this.compactionState;
      // 固定开销与消息共用同一份预算（工具 schema + **尚未拼入**的 repo-map 尾段）。
      const requestOverhead: RequestOverhead = {
        ...(overhead?.tools !== undefined ? { tools: overhead.tools } : {}),
        ...(repoMap !== null ? { trailingText: repoMap } : {}),
      };
      const result = await compactor.compact(
        projectedForModel,
        previous,
        requestOverhead,
        forceCompaction,
      );
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
    // 动态段合并为**一条** system 尾消息：repo-map 与延迟工具清单若各占一条，会让
    // “上一条请求的尾部”有两个可变元素，前缀复用判据/真实缓存都多断一次。
    this.appendDynamicTail(messages, repoMap, overhead?.tools !== undefined);
    this.measurePrefixReuse(messages);
    return messages;
  }

  /**
   * CTX-01 逃生口：默认开；`OMNI_CONTEXT_SHAPERS=0` 回到逐字旧行为（便于定位前缀/压缩回归）。
   * @param messages 原始投影消息。
   * @returns 削减后的消息（关闭时原样返回）。
   */
  private shapeIfEnabled(
    messages: readonly ModelMessage[],
    aggressive: boolean,
  ): readonly ModelMessage[] {
    return process.env.OMNI_CONTEXT_SHAPERS === '0' ? messages : this.shape(messages, aggressive);
  }

  /**
   * CTX-01：在摘要压缩之前先做两层零成本/低成本削减（超长工具结果头尾裁剪、旧工具轮剪枝）。
   * @param messages 原始投影消息。
   * @param aggressive 强制压缩路径才允许改写旧消息（默认只裁最新一条，保前缀缓存）。
   * @returns 削减后的消息（未触发时逐字等于输入）。
   */
  private shape(messages: readonly ModelMessage[], aggressive: boolean): readonly ModelMessage[] {
    const shaped = ContextShapers.apply(messages, {
      ...(this.deps.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.deps.contextWindowTokens }
        : {}),
      aggressive,
    });
    if (shaped.report.trimmedToolResults > 0 || shaped.report.snippedToolResults > 0) {
      log.debug('context.shapers', { ...shaped.report });
    }
    return shaped.messages;
  }

  /**
   * 追加唯一的动态尾部：repo-map 与延迟工具清单合并，保证相邻请求只改**一条**尾消息。
   * @param messages 当前消息列表（就地追加）。
   * @param repoMap repo-map 文本或 null。
   * @param hasTools 本轮是否传了工具集（finalize 的 tools:[] 不列延迟工具）。
   * @returns 无返回值。
   */
  private appendDynamicTail(
    messages: ModelMessage[],
    repoMap: string | null,
    hasTools: boolean,
  ): void {
    const tail: string[] = [];
    if (repoMap !== null) tail.push(repoMap);
    if (this.lastDeferredTools.length > 0 && hasTools) {
      const shown = this.lastDeferredTools.slice(0, 20).join(', ');
      const more =
        this.lastDeferredTools.length > 20 ? ` 等 ${String(this.lastDeferredTools.length)} 个` : '';
      tail.push(
        `本轮未直载的工具（按任务相关性延迟，可先调用 tool_search 找回）：${shown}${more}。` +
          '若完成任务需要其中某个工具，请先 tool_search 检索，而不是用 shell/run_code 自行变通。',
      );
    }
    if (tail.length > 0) messages.push({ role: 'system', content: tail.join('\n\n') });
  }

  /**
   * 读取本工作区的常驻指令，作为消息头部的稳定前缀。
   *
   * 同一工作区内容稳定，放在动态派生信息之前可命中 provider 前缀缓存；
   * 任何读取/解析失败均 fail-closed（返回空数组），绝不因指令文件问题阻断主流程。
   * @returns 指令片段（0 或 1 条）
   */
  private async projectInstructionFragments(): Promise<string[]> {
    if (this.deps.workspaceRoot === undefined || this.deps.projectInstructionsEnabled === false) {
      return [];
    }
    const instructions = await ProjectInstructions.loadProjectInstructionsCached({
      workspaceRoot: this.deps.workspaceRoot,
    });
    return instructions === null ? [] : [instructions.content];
  }

  /**
   * 最近一次 {@link buildMessages} 测得的前缀复用率（0–1；首次请求为 undefined）。
   *
   * 供 `StepRunner` 写进 `ModelContextSnapshot.prefixReuseRatio` —— 缓存未命中分因
   * （`CacheMissAttributionAnalyst`）需要这个信号，而它只在请求路径上算得出来。
   * **只读**：不改任何行为，读取方拿不到就是"没测到"，不得当成 0。
   * @returns 复用率；无基准（首次请求）或尚未组装过时为 undefined。
   */
  public get prefixReuseRatioOfLastBuild(): number | undefined {
    return this.lastPrefixReuseRatio;
  }

  /**
   * 取单条消息的 JSON 片段（带 WeakMap 记忆）。
   * @param message 单条模型消息
   * @returns `JSON.stringify(message)` 的结果（同一对象只算一次）
   */
  private serializeMessage(message: ModelMessage): string {
    const cached = this.serializedMessages.get(message);
    if (cached !== undefined) return cached;
    const json = JSON.stringify(message);
    this.serializedMessages.set(message, json);
    return json;
  }

  /**
   * 量一次**相邻请求的前缀复用率**并记 debug 指标（G1b-b，2026-10-03）。
   *
   * 为什么放在这里：前缀缓存能否命中，取决于相邻两次请求的**序列化前缀是否逐字节相同**——
   * 这是 prompt cache 命中率唯一可离线测量的代理指标；而仓内 `PrefixStability` 这个仪器原先
   * **只被导出、没有任何生产调用点**（报告 §3.2 发现 6）。本方法把它接进真实请求路径，
   * 且**不改变任何行为**（只测、只记）。
   *
   * 口径：`reuse = |commonPrefix| / |上次序列化| ∈ [0,1]`；首次请求无可比对象 ⇒ 记为
   * `undefined`（**不猜 0**——0 的含义是"前缀被完全改写"，与"没基准"完全不是一回事）。
   *
   * **按消息缓存序列化**（2026-10-18）：长会话里相邻两步的消息**绝大多数是同一批对象**，
   * 逐字节重新 `JSON.stringify(整个数组)` 是纯浪费。这里用 `WeakMap<消息对象, 该消息的 JSON>`
   * 做记忆：只有新增/改写的消息需要序列化，拼接结果与 `JSON.stringify(array)` **逐字节相同**
   * （对象数组的 JSON 就是 `[a,b,…]`，用 `','` 连接即可）⇒ 复用率口径与诊断数值都不变。
   * 实测 200 条 × 8 KB（1.6 MB）：3.7 ms → 0.89 ms；WeakMap 随消息对象回收，不累积内存。
   * @param messages 本轮组装完成、即将发给模型的消息（含尾部动态段）。
   * @returns 无返回值。
   */
  private measurePrefixReuse(messages: readonly ModelMessage[]): void {
    const current = `[${messages.map((m) => this.serializeMessage(m)).join(',')}]`;
    const previous = this.lastSerialized;
    this.lastSerialized = current;
    if (previous === undefined) {
      // 显式清空：复用率是"相对上一条请求"的量，没有基准时留着上一步的值就是错读数。
      this.lastPrefixReuseRatio = undefined;
      return;
    }
    // 先四舍五入再同时用于日志与快照：两处口径必须逐位一致（否则面板与日志会各说各话）。
    const reuse = Number(PrefixStability.prefixReuse(previous, current).toFixed(4));
    this.lastPrefixReuseRatio = reuse;
    log.debug('context.prefix_reuse', {
      reuse,
      messages: messages.length,
      previousChars: previous.length,
      currentChars: current.length,
    });
  }

  /**
   * 发给模型的工具集：直载（listDirect，剔除 deferred）∪ 经 tool_search 发现的延迟加载工具。
   * 按名去重：被发现的工具补充进上下文，使其可被模型真正调用（#M1 延迟加载闭环）。
   *
   * **按需暴露（`OMNI_TOOL_EXPOSURE`，**默认 `plan`**，2026-10-02 起；`off` 为逃生口）**：
   * 先经 {@link ToolExposurePlanner}
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
   * 按相关性裁剪直载工具（`OMNI_TOOL_EXPOSURE=off` 是显式逃生口；默认 `plan`）。
   *
   * 任务文本复用 repo-map 的同一推导（最近至多 3 条 user 消息），**不额外读状态**，
   * 保证同一回合内 repo-map 与工具暴露看到的是同一个查询。
   *
   * @param direct 直载工具定义列表。
   * @returns 裁剪后的工具定义列表（`off` 时与入参同一数组，零成本）。
   */
  private exposeByRelevance(direct: readonly ToolDefinition[]): readonly ToolDefinition[] {
    if (ToolExposurePlanner.modeFromEnv() !== 'plan') {
      this.lastDeferredTools = [];
      return direct;
    }
    // T2（2026-10-03）：把工具的**描述 + schema** 一并交给规划器，BM25 检索路才有语料可检索。
    // 为什么必须在这里接：规划器只看名字时，"描述相关但类别没登记"的必需工具捞不回来
    //（判据 ③ 就是钉这件事）。声明了参数却没人传，等于没接线——本仓最高频的缺陷形态。
    const toolTexts = new Map(
      direct.map((tool) => [
        tool.name,
        `${tool.description ?? ''} ${JSON.stringify(tool.parameters ?? {})}`,
      ]),
    );
    const plan = ToolExposurePlanner.plan({
      taskText: this.deriveQueryText(this.deps.recorder.allEvents()),
      tools: direct.map((tool) => tool.name),
      toolTexts,
    });
    this.lastDeferredTools = plan.deferred;
    if (plan.deferred.length === 0) return direct;
    const keep = new Set(plan.visible);
    return direct.filter((tool) => keep.has(tool.name));
  }

  /**
   * repo-map 的**任务形状闸**：纯创作/视觉任务不注入代码大纲。
   *
   * 为什么需要（2026-10-19 鹈鹕会话实测）：任务是「画一个 SVG 动画」，repo-map 却每步注入
   * 约 1.5k token 的代码符号大纲；模型在 reasoning 里 6 次写「The repo map is unrelated —
   * ignore」。这不是 token 成本问题（缓存后很便宜），而是**注意力稀释**：模型要反复判断
   * 哪些上下文与本任务无关。
   *
   * 判据刻意保守：只有「视觉/创作动词」**且**「没有任何代码信号」时才跳过。
   *  - 视觉/创作：画 / 绘制 / 插画 / 海报 / 动画 / logo / 配色 / 排版 / 壁纸；
   *  - 代码信号：代码/函数/模块/接口/实现/修复/测试/编译/报错/重构/依赖/版本/
   *    组件/路由/样式/脚本/命令/配置，或真实文件扩展名（`.ts`/`.py`/`.html`…）或路径分隔符。
   *
   * 「创建一个 HTML」不含「画/绘制」，仍会注入 repo-map——创建网页可能要看现有组件；
   * 「用 SVG 绘制动画」则跳过。误判代价只是少一份可选的代码大纲，不会阻断任何工具。
   *
   * @param query 任务文本（最近至多 3 条真实 user 消息拼接）。
   * @returns 是否构建 repo-map。
   */
  public static shouldBuildRepoMap(query: string): boolean {
    // 先剔除「否定测试」短语：鹈鹕原话「你不需要任何测试」里的「测试」会把纯视觉任务
    // 误判成代码任务（同一类否定语义污染，在工具暴露的关键词匹配里也出现过）。
    const text = query
      .toLowerCase()
      .replace(/(?:不需要|无需|不要|不用|禁止)[^。；，,\n]{0,8}测试/gu, '');
    const visual = /画|绘制|插画|海报|动画|logo|配色|排版|壁纸/u.test(text);
    if (!visual) return true;
    const code =
      /代码|函数|模块|接口|实现|修复|测试|编译|报错|重构|依赖|版本|组件|路由|样式|脚本|命令|配置|调试|逻辑|数据/u.test(
        text,
      ) ||
      /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs|cpp|c|h|md|json|css|scss|html|vue|svelte)\b/u.test(
        text,
      ) ||
      /[/\\]/u.test(text);
    return code;
  }

  /**
   * 从事件日志推导 repo-map 查询文本：取最近最多 3 条 user 消息的 content 拼接。
   * 仅用 user 文本（避开工具结果噪声），足以驱动 repo-map 的相关文件召回。
   *
   * @param events 会话事件日志（倒序扫描，取最近 3 条**真实** user 文本）。
   * @returns 按时间正序拼接的查询文本；无 user 文本时为空串。
   */
  private deriveQueryText(events: readonly SessionEvent[]): string {
    const texts: string[] = [];
    for (let i = events.length - 1; i >= 0 && texts.length < 3; i--) {
      const e = ArrayAt.at(events, i);
      if (e.type === 'user') {
        const payload = e.payload as { content?: string; synthetic?: boolean };
        // harness 注入的 nudge 不是用户意图：把它算进任务文本会让工具表 / repo-map 中途漂移
        //（nudge 文案里常含「文件」「工具」等关键词，足以翻转 ToolExposurePlanner 的类别命中）。
        if (payload.synthetic === true) {
          continue;
        }
        const content = payload.content;
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
  /**
   * 回滚后**重新对齐**压缩游标（2026-10-03 第六轮修看板 §8.2）。
   *
   * 为什么需要：`compactionState` 是**进程内**状态，只在构造后首次 `buildMessages` 时从事件日志恢复一次
   * （L101-104）；而 `checkpoint` 回滚会把 `OMNI_COMPACTION_V1` 游标事件从日志里**截掉** ⇒ 内存游标悬空——
   * 它引用了一个日志中已不存在的折叠点。症状是"同一进程内不对、重启后对了"（重启后新实例会重新恢复），
   * 属最难查的一类。
   *
   * 为什么**不**把 `stateRestored` 置回 false：那会让下一次 `buildMessages` 走"首次恢复"路径并把 `previous`
   * 当 undefined 处理，可能多付一次摘要 LLM 调用（正是本文件 L100-137 注释记录的旧缺陷 P0-1）。
   * 这里**就地重新推导**：把游标换成"截断后日志里的最后一条标记"（没有标记即 undefined）。
   * @returns 无返回值。
   */
  public rewindCompactionState(): void {
    this.stateRestored = true;
    this.compactionState = this.restoreCompactionState(this.deps.recorder.allEvents());
  }
}
