import type { SessionEvent } from '../ports/runtime/event.js';
import type { ModelMessage } from '../ports/model/model.js';
import type { ToolDefinition } from '../ports/tool/tool.js';
import { ContextAssembler } from '../context/contextAssembler.js';
import { loadProjectInstructionsCached } from '../context/projectInstructions.js';
import {
  type CompactionState,
  encodeCompactionState,
  decodeCompactionState,
} from '../context/contextCompactor.js';
import type { StepRunnerDeps } from './stepTypes.js';
import { at } from '../util/arrayAt.js';

/**
 * P5 自动降档时 repo-map 注入的文件预算（fileK）：从默认 10 收缩到 5，
 * 直接压低注入上下文的 token 量。符号预算（symK=24）保持默认——repo-map 的 token 成本
 * 主要由文件 outline 主导，缩 fileK 已是主要杠杆；符号签名行体量小，不动它以免过度损害召回信号。
 */
const DEGRADE_FILE_K = 5;

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
      const instructions = await loadProjectInstructionsCached({
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
      const result = await compactor.compact(projected, this.compactionState);
      if (result.state !== undefined) {
        // 游标持久化：写回事件日志（system 事件），崩溃/重启后可恢复，跨步复用摘要。
        this.compactionState = result.state;
        this.deps.recorder.system(encodeCompactionState(result.state));
      } else if (result.compacted && this.compactionState === undefined) {
        // 无游标路径（head 为空的退化压缩）：维持旧行为的提示文本。
        this.deps.recorder.system(
          `上下文压缩: 已折叠较早历史（摘要 ${result.summary?.length ?? 0} 字）`,
        );
      } else if (result.compacted && this.compactionState !== undefined) {
        this.deps.recorder.system(
          `上下文压缩: 复用既有摘要（游标 upTo=${this.compactionState.compactedUpTo}）`,
        );
      }
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
   * @returns 去重后的工具定义列表（直载项优先，发现的同名项被丢弃）。
   */
  public effectiveTools(): ToolDefinition[] {
    const direct = this.deps.tools.listDirect?.() ?? this.deps.tools.list();
    const discovered = this.deps.discovery?.list() ?? [];
    const byName = new Map<string, ToolDefinition>();
    for (const tool of direct) {
      byName.set(tool.name, tool);
    }
    for (const tool of discovered) {
      if (!byName.has(tool.name)) {
        byName.set(tool.name, tool);
      }
    }
    return [...byName.values()];
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
      const e = at(events, i);
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
      const e = at(events, i);
      if (e.type !== 'system') {
        continue;
      }
      const content = (e.payload as { content?: string }).content;
      if (typeof content !== 'string' || !content.startsWith('OMNI_COMPACTION_V1')) {
        continue;
      }
      return decodeCompactionState(content);
    }
    return undefined;
  }

  /**
   * 推导并产出 repo-map 上下文（BM25 或混合检索）。
   * 任一路径失败均返回 null（fail-closed），不影响主流程。
   *
   * P5 自动降档：当预算降级信号置位（`budgetDegrade.shouldDegrade` 为真，即软阈值已越过、
   * 硬预算尚未熔断）时，**强制纯 BM25**（忽略语义嵌入端口）并缩小 fileK 到 {@link DEGRADE_FILE_K}、
   * 关闭第二段词法重排，直接压低注入上下文的 token 量。无信号（默认部署 / 未越软阈值 / 已熔断）
   * 时保持生产检索口径（纯 BM25 或混合检索，预算取默认档），不再额外降档。
   * 注：`fileK` 生产默认值已于 2026-09-17 由 10 提到 14（见 `repoMapContextEngine.DEFAULT_FILE_K`）；
   * 降档档位 {@link DEGRADE_FILE_K} 是**刻意的应急压缩档**（预算越界时优先保 token），未随之调整。
   *
   * @param q 由最近 user 消息推导出的查询文本（非空）。
   * @returns repo-map 上下文片段；不可用时为 null。
   */
  private async buildRepoMapContext(q: string): Promise<string | null> {
    const root = this.deps.workspaceRoot!;
    const engine = this.deps.repoMapContext;
    const degrade = this.deps.budgetDegrade?.shouldDegrade === true;
    if (degrade) {
      // 降级：纯 BM25 + 缩 fileK + 关重排（即便注入过 embedding 也强制落在零开销词法路）。
      return engine.getRepoMapContext(root, q, { fileK: DEGRADE_FILE_K, rerank: false });
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
