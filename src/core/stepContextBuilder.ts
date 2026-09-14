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
   * @returns 投影 + 压缩后发给模型的消息列表（跨步复用压缩游标）。
   */
  public async buildMessages(): Promise<readonly ModelMessage[]> {
    const events = this.deps.recorder.allEvents();
    const extraSystemFragments: string[] = [];
    // 常驻指令优先于动态上下文：权威规则应先于 repo-map 等派生信息进入模型视野。
    // 任何读取/解析失败均 fail-closed（返回 null 即跳过），绝不因指令文件问题阻断主流程。
    if (this.deps.workspaceRoot !== undefined && this.deps.projectInstructionsEnabled !== false) {
      const instructions = await loadProjectInstructionsCached({
        workspaceRoot: this.deps.workspaceRoot,
      });
      if (instructions !== null) {
        extraSystemFragments.push(instructions.content);
      }
    }
    // U2：从当前上下文推导 repo-map 并注入系统消息（fail-closed：任何失败都不影响主流程）。
    // 若注入了语义嵌入端口，则走混合检索（BM25 ∪ 语义 RRF），否则纯 BM25（零开销）。
    if (this.deps.workspaceRoot !== undefined && this.deps.repoMapEnabled !== false) {
      const q = this.deriveQueryText(events);
      if (q !== '') {
        const repoMap = await this.buildRepoMapContext(q);
        if (repoMap !== null) {
          extraSystemFragments.push(repoMap);
        }
      }
    }
    const projected = this.assembler.build(events, extraSystemFragments);
    const compactor = this.deps.compactor;
    if (compactor === undefined) {
      return projected;
    }
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
    return result.messages;
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
   * @param q 由最近 user 消息推导出的查询文本（非空）。
   * @returns repo-map 上下文片段；不可用时为 null。
   */
  private async buildRepoMapContext(q: string): Promise<string | null> {
    const root = this.deps.workspaceRoot!;
    const engine = this.deps.repoMapContext;
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
