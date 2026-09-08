import type { ApprovalPort } from '../ports/approval.js';
import type { SessionEvent } from '../ports/event.js';
import type { SandboxPort } from '../ports/sandbox.js';
import type { ToolContext, ToolCall, ToolDefinition, ToolPort, ToolResult } from '../ports/tool.js';
import type { ModelMessage, ModelPort } from '../ports/model.js';
import type { EscalationPort } from '../ports/escalation.js';
import { ContextAssembler } from '../context/contextAssembler.js';
import {
  getRepoMapContext,
  getHybridRepoMapContext,
  clearRepoMapCache,
} from '../context/repoMapContext.js';
import type { EmbeddingPort } from '../ports/embedding.js';
import { loadProjectInstructionsCached } from '../context/projectInstructions.js';
import type { ContextCompactor } from '../context/contextCompactor.js';
import type { ToolResultSpiller } from '../context/toolResultSpiller.js';
import { ToolGate, MUTATING_TOOLS } from './toolGate.js';
import type { ToolHookRunner } from './toolHooks.js';
import type { SessionRecorder } from './sessionRecorder.js';
import type { NativeToolRunner } from '../native/nativeBackend.js';
import type { ToolDiscovery } from '../search/toolDiscovery.js';
import { isLikelySandboxDenied } from '../adapters/sandbox/denial.js';
import type { ToolInputSink } from '../ports/toolInputSink.js';
import type { SupervisorPort } from '../ports/supervisor.js';
import { log } from '../util/logger.js';
import { guardToolResult } from '../security/promptInjectionGuard.js';

/** 单步运行依赖（全部来自端口）。 */
export interface StepRunnerDeps {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly approvals: ApprovalPort;
  readonly sandbox: SandboxPort;
  readonly recorder: SessionRecorder;
  readonly sessionId: string;
  readonly compactor?: ContextCompactor;
  readonly fragments?: readonly string[];
  readonly hooks?: ToolHookRunner;
  /** 外溢器（#74）：超大工具输出入历史前先落后端，只留有界预览。 */
  readonly spiller?: ToolResultSpiller;
  /** 原生后端（FFI #66）：非空时工具执行路由到 Rust 内核 in-process；内核不可用由 RuntimeFactory 置空以回退 JS。 */
  readonly native?: NativeToolRunner;
  /** 工具发现寄存器（#M1）：tool_search 命中后登记，使延迟加载工具后续回合对模型可见。 */
  readonly discovery?: ToolDiscovery;
  /** 升级审批端口（#G3/G4，可选）：运行时装配应注入 `runtime.escalation`。 */
  readonly escalation?: EscalationPort;
  /** 提权后的复核沙箱（#G3/G4，可选）：运行时装配应注入 `runtime.elevatedSandbox`。 */
  readonly elevatedSandbox?: SandboxPort;
  /**
   * 统一门禁（审批 + 沙箱 + 计划态）。不传则由 approvals/sandbox 造默认，
   * 但会丢失计划门禁——运行时装配应传入 `runtime.gate`（plan-aware）。
   */
  readonly gate?: ToolGate;
  /** 航天级监督内核（I-P0-3，可选）：工具执行成败上报此端口，驱动健康监控与 Safe mode 分级降级。 */
  readonly supervisor?: SupervisorPort;
  /**
   * 工具输入实时观察端口（#B3）：非空且模型支持 stream 时，模型流式生成的工具参数增量
   * 会实时转发到此端口供 UI 渐进渲染。缺失或模型不支持 stream 时退回 generate 路径，行为不变。
   */
  readonly live?: ToolInputSink;
  /** 提示注入护栏（opt-in）：为 true 时工具结果进上下文前做指令注入扫描并隔离命中项。 */
  readonly promptInjectionGuard?: boolean;
  /** 推理强度（#B6，可选）：透传为模型 reasoning_effort；缺省按模型默认。 */
  readonly reasoningEffort?: string;
  /**
   * 工作区根路径（U2）：非空时每步从当前查询推导 repo-map 上下文注入系统消息。
   * 配合 repoMapEnabled（默认开）使用；env OMNI_REPO_MAP=0 由装配层置 false 关闭。
   */
  readonly workspaceRoot?: string;
  /** repo-map 上下文注入开关（U2，默认开；传 false 即关）。 */
  readonly repoMapEnabled?: boolean;
  /**
   * 语义嵌入端口（U3 混合检索）：非空时 repo-map 走「BM25 ∪ 语义向量 RRF」混合路径，
   * 补词法盲区。默认不传 → 纯 BM25（零开销、不加载 80MB 模型）。
   * 仅在 env OMNI_SEMANTIC_RECALL=1 由 RuntimeFactory 构造并注入；任何异常 fail-closed 回退 BM25。
   */
  readonly embedding?: EmbeddingPort;
  /**
   * 仓库常驻指令（AGENTS.md / CLAUDE.md / llms.txt）注入开关，默认开；传 false 即关。
   * 依赖 `workspaceRoot`：该值为空时无论开关如何都不注入。
   * 行业约定（6 万+ 仓库，Linux Foundation 治理），env OMNI_PROJECT_INSTRUCTIONS=0 由装配层置 false。
   */
  readonly projectInstructionsEnabled?: boolean;
}

/** 单步结果类型。 */
export type StepOutcome = 'text' | 'tool' | 'empty';

/**
 * 从事件日志推导 repo-map 查询文本：取最近最多 3 条 user 消息的 content 拼接。
 * 仅用 user 文本（避开工具结果噪声），足以驱动 repo-map 的相关文件召回。
 */
function deriveQueryText(events: readonly SessionEvent[]): string {
  const texts: string[] = [];
  for (let i = events.length - 1; i >= 0 && texts.length < 3; i--) {
    const e = events[i]!;
    if (e.type === 'user') {
      const content = (e.payload as { content?: string }).content;
      if (content !== undefined && content.trim() !== '') {
        texts.push(content.trim());
      }
    }
  }
  return texts.reverse().join('\n');
}

/** 单步执行器：一次模型请求 + 经 审批→沙箱→执行 链路的工具调用。 */
export class StepRunner {
  private readonly assembler: ContextAssembler;
  private readonly gate: ToolGate;

  constructor(private readonly deps: StepRunnerDeps) {
    this.gate =
      deps.gate ??
      new ToolGate(
        deps.approvals,
        deps.sandbox,
        undefined,
        false,
        deps.escalation,
        deps.elevatedSandbox,
      );
    this.assembler = new ContextAssembler(deps.fragments);
  }

  /** 运行一步。 */
  async run(context: ToolContext): Promise<StepOutcome> {
    const output = await this.requestModel();
    this.recordReasoning(output.reasoning);
    // 模型用量落事件流（#S29 / live 跑分成本计量）；无 usage 静默跳过，绝不臆造。
    // 带上模型名，供服务端 token 统计按模型分组。
    if (output.usage !== undefined) {
      this.deps.recorder.usage(output.usage, this.deps.model.name);
    }
    if (output.toolCalls !== undefined && output.toolCalls.length > 0) {
      await this.runToolCalls(output.toolCalls, context);
      return 'tool';
    }
    if (output.text !== undefined) {
      // 把模型同一回合的推理内容（DeepSeek v4 reasoning 模式输出）一并塞进 assistant 事件，
      // 不依赖 reasoning/assistant 事件流时序——避免下轮 HTTP 400（#OBS-5）。
      this.deps.recorder.assistant(output.text, output.reasoning);
      return 'text';
    }
    return 'empty';
  }

  /**
   * 步数耗尽兜底（#OBS-9）：做一次「无工具」模型调用，强制模型基于已有上下文
   * 直接产出最终答复。
   *
   * 场景：模型持续调用工具（探索/检索/验证）而从未输出文本，跑满 maxSteps 后
   * TurnRunner 退出、finalText 为 undefined，用户侧表现为「转了很久没有任何结果」。
   * 2026-09-08 真机复现：steps=16 / session.end hasText:false。
   *
   * 实现要点：
   *  - tools 传空数组，模型无法再调工具，只能输出文本；
   *  - 末尾追加一条显式 user 指令，避免模型回「需要更多信息」继续空转；
   *  - 产出的文本经 recorder.assistant 入事件流，UI 与 threads.get 都能取到；
   *  - 全程 fail-closed：任何异常都吞掉返回 undefined，绝不阻断主流程。
   */
  async finalize(): Promise<string | undefined> {
    try {
      const base = await this.buildMessages();
      const messages: ModelMessage[] = [
        ...base,
        {
          role: 'user',
          content:
            '【系统提示】工具调用步数已达上限。请立即基于上文中已经获得的所有信息，' +
            '直接给出最终答复与结论；不要再请求调用任何工具，也不要说需要更多信息。',
        },
      ];
      const request = { messages, tools: [], reasoningEffort: this.deps.reasoningEffort };
      log.info('step.finalize', { messageCount: messages.length });
      const stream = this.deps.model.stream;
      const output =
        stream !== undefined
          ? await stream.call(this.deps.model, request, { onText: () => {} })
          : await this.deps.model.generate(request);
      if (output.usage !== undefined) {
        this.deps.recorder.usage(output.usage, this.deps.model.name);
      }
      const text = output.text;
      if (text === undefined || text.trim() === '') return undefined;
      this.deps.recorder.assistant(text, output.reasoning);
      return text;
    } catch {
      return undefined;
    }
  }

  /**
   * 请求模型（上下文从事件日志投影，超预算先压缩）。
   * #B3：若 live 端口非空且模型支持 stream，走流式并在 onToolInput 回调里把工具参数增量
   * 转发给 live 端口供 UI 实时渲染；否则退回原 generate 路径（行为逐字节一致，fail-closed）。
   */
  private async requestModel(): Promise<ReturnType<ModelPort['generate']>> {
    const messages = await this.buildMessages();
    const tools = this.effectiveTools();
    log.debug('model.request', { messageCount: messages.length, toolCount: tools.length });
    const stream = this.deps.model.stream;
    const request = { messages, tools, reasoningEffort: this.deps.reasoningEffort };
    if (this.deps.live !== undefined && stream !== undefined) {
      return stream.call(this.deps.model, request, {
        onText: () => {},
        onToolInput: (delta) => this.deps.live!.onToolInput(delta),
      });
    }
    return this.deps.model.generate(request);
  }

  /**
   * 发给模型的工具集：直载（listDirect，剔除 deferred）∪ 经 tool_search 发现的延迟加载工具。
   * 按名去重：被发现的工具补充进上下文，使其可被模型真正调用（#M1 延迟加载闭环）。
   */
  private effectiveTools(): ToolDefinition[] {
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

  /** 组装模型消息（按需压缩）。 */
  private async buildMessages(): Promise<readonly ModelMessage[]> {
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
      const q = deriveQueryText(events);
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
    const result = await compactor.compact(projected);
    if (result.compacted) {
      this.deps.recorder.system(
        `上下文压缩: 已折叠较早历史（摘要 ${result.summary?.length ?? 0} 字）`,
      );
    }
    return result.messages;
  }

  /**
   * 推导并产出 repo-map 上下文（BM25 或混合检索）。
   * 任一路径失败均返回 null（fail-closed），不影响主流程。
   */
  private async buildRepoMapContext(q: string): Promise<string | null> {
    const root = this.deps.workspaceRoot!;
    if (this.deps.embedding !== undefined) {
      try {
        return await getHybridRepoMapContext(root, q, this.deps.embedding);
      } catch {
        // 混合检索异常 → 回落纯 BM25（不应发生，getHybridRepoMapContext 自身已 fail-closed，双保险）。
        return getRepoMapContext(root, q);
      }
    }
    return getRepoMapContext(root, q);
  }

  /** 记录推理轨迹。 */
  private recordReasoning(reasoning: string | undefined): void {
    if (reasoning !== undefined && reasoning !== '') {
      this.deps.recorder.reasoning(reasoning);
    }
  }

  /** 串行执行全部工具调用。 */
  private async runToolCalls(calls: readonly ToolCall[], context: ToolContext): Promise<void> {
    for (const call of calls) {
      await this.runToolCall(call, context);
    }
  }

  /** 执行单个工具调用（审批 → 沙箱 → pre 钩子 → 执行 → post 钩子）。 */
  private async runToolCall(call: ToolCall, context: ToolContext): Promise<void> {
    // 审批 + 沙箱门禁（用户配置策略层）：native 与 JS 路径共用同一道门禁，
    // 保证 --approval / --sandbox 在两种后端下行为一致（修复 #66 旁路缺陷）。
    const denied = await this.gate.gate(call, context.sessionId);
    if (denied !== undefined) {
      log.warn('tool.denied', { tool: call.name, callId: call.id, error: denied.error });
      // 先记录 toolCall 事件：被拒工具若只留 tool_result（无对应 tool_call），ContextAssembler
      // 会产出 tool_call_id 悬空的 tool 消息，发给模型时触发 HTTP 400。补 toolCall 使配对合法。
      this.deps.recorder.toolCall(call.id, call.name, call.arguments);
      this.deps.recorder.toolResult(denied.callId, false, undefined, denied.error);
      return;
    }
    log.info('tool.call', { tool: call.name, callId: call.id });
    this.deps.recorder.toolCall(call.id, call.name, call.arguments);
    const hookContext = {
      sessionId: context.sessionId,
      toolName: call.name,
      target: this.targetOf(call),
      args: call.arguments,
    };
    // pre 钩子必须先于任何执行路径（native FFI / JS）：pre 的语义是「执行前拦截/审计」，
    // 放到执行之后就退化成事后通知，既拦不住也记不准。
    // pre 自身抛错直接向上抛——绝不回退重跑，否则写类工具会被执行两次。
    if (this.deps.hooks !== undefined) {
      await this.deps.hooks.pre(hookContext);
    }
    // FFI 热路径（#66）：pre 之后才真正执行；内部失败回退下方 JS 路径
    //（门禁已通过、pre 已执行一次，回退时不重复跑 pre）。
    if (this.deps.native !== undefined) {
      try {
        const result = this.deps.native.runTool(call);
        await this.recordToolResult(call.name, result, context.sessionId);
        if (this.deps.hooks !== undefined) {
          await this.deps.hooks.post(hookContext, result);
        }
        // U4：原生后端路径同样在写类工具成功执行后失效 repo-map 缓存。
        this.maybeInvalidateRepoMap(call, result);
        return;
      } catch {
        log.debug('tool.native.fallback', { tool: call.name, callId: call.id });
      }
    }
    const result = await this.deps.tools.execute(call, context);
    if (this.deps.hooks !== undefined) {
      await this.deps.hooks.post(hookContext, result);
    }
    // 钩子拿到完整结果（持久化/观测无损），入模型上下文前再外溢。
    await this.recordToolResult(call.name, result, context.sessionId);
    // U4：写类工具成功执行后主动失效 repo-map 缓存（消除 30s TTL 陈旧窗口）。
    this.maybeInvalidateRepoMap(call, result);
  }

  /**
   * U4：写类工具成功执行后主动失效 repo-map 缓存，消除 30s TTL 陈旧窗口。
   * fail-closed：workspaceRoot 未注入 / 工具未成功 / 非写类工具 / 失效抛错，均静默跳过，绝不崩主流程。
   */
  private maybeInvalidateRepoMap(call: ToolCall, result: { ok: boolean }): void {
    if (this.deps.workspaceRoot === undefined) {
      return;
    }
    if (!result.ok) {
      return;
    }
    if (!MUTATING_TOOLS.has(call.name)) {
      return;
    }
    try {
      clearRepoMapCache(this.deps.workspaceRoot);
    } catch {
      // 缓存失效失败不影响主流程
    }
  }

  /** 记录工具结果（#74）：超大输出先外溢为预览 + 定位符，避免撑爆上下文。 */
  private async recordToolResult(
    toolName: string,
    result: ToolResult,
    sessionId: string,
  ): Promise<void> {
    const spiller = this.deps.spiller;
    const stored =
      spiller === undefined ? result : await spiller.apply(toolName, result, sessionId);
    if (spiller !== undefined) {
      log.debug('tool.spilled', { tool: toolName, ok: result.ok });
    }
    const guarded =
      this.deps.promptInjectionGuard === true ? this.guardInjection(toolName, stored) : stored;
    const annotated = this.annotateDenial(guarded);
    this.deps.recorder.toolResult(
      annotated.callId,
      annotated.ok,
      annotated.output,
      annotated.error,
    );
    // I-P0-3：工具执行成败上报监督内核（native + JS 全路径共用此处，覆盖完整）。
    this.deps.supervisor?.report(toolName, annotated.ok ? 'success' : 'failure', annotated.error);
  }

  /**
   * 提示注入护栏（opt-in）：工具结果 output 进模型上下文前做确定性扫描，命中即隔离
   * （替换为隔离标记，保留「已被拦截」信号，不把疑似注入喂给模型）。失败开放：guardToolResult
   * 异常时回落原始结果，不阻断主流程。
   */
  private guardInjection(toolName: string, result: ToolResult): ToolResult {
    try {
      const guarded = guardToolResult(result);
      if (guarded.blocked) {
        log.warn('tool.injection', { tool: toolName, hits: guarded.hits.length });
      }
      return guarded;
    } catch {
      return result;
    }
  }

  /**
   * 执行期沙箱拒绝标注（G3）：若结果为失败且错误特征命中 OS 沙箱拒绝签名，
   * 前缀 [沙箱拒绝] 便于模型/可观测层识别"这是沙箱拦截而非一般错误"，进而决定是否提权重试。
   */
  private annotateDenial(result: ToolResult): ToolResult {
    if (result.ok || result.error === undefined) {
      return result;
    }
    if (isLikelySandboxDenied({ message: result.error })) {
      return { ...result, error: `[沙箱拒绝] ${result.error}` };
    }
    return result;
  }

  /** 提取动作目标（用于钩子/记录）。 */
  private targetOf(call: ToolCall): string {
    return String(call.arguments['command'] ?? call.arguments['path'] ?? call.name);
  }
}
