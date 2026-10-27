import type { ToolContext, ToolCall, ToolResult } from '../ports/tool/tool.ts';
import { ToolGate, MUTATING_TOOLS, REPO_MAP_INVALIDATING_TOOLS } from './toolGate.ts';
import type { ToolGatePort } from '../ports/runtime/toolGatePort.ts';
import { ToolScheduler } from './loop/toolScheduler.ts';
import { SandboxDenial } from '../security/sandboxDenial.ts';
import { PromptInjectionGuard } from '../security/promptInjectionGuard.ts';
import {
  EnforcementModeResolver,
  type EnforcementMode,
} from '../security/enforcementModeResolver.ts';
import { ToolOutputTrust } from '../security/toolOutputTrust.ts';
import { ProvenanceTracker } from '../security/provenanceTracker.ts';
import { TOOL_NAMES } from '../ports/tool/toolNames.ts';
import { log } from '../util/logger.ts';
import { SupervisorHealthSignal } from '../supervisor/healthSignal.ts';
import type { StepRunnerDeps } from './stepTypes.ts';

/**
 * 单步「工具执行」协作者（从 `StepRunner` 按职责缝抽出，P6.3 上帝类收口）。
 *
 * 职责单一：把模型本步发出的工具调用，按
 * **门禁 → pre 钩子 → （native FFI | JS）执行 → post 钩子 → 结果记录** 的固定链路落地。
 *
 * 四条不可动的行为约束（抽类时逐字保留，均有实测背景）：
 *  1. `pre` 钩子必须先于任何执行路径——放到执行之后会退化为事后通知，既拦不住也记不准；
 *  2. 工具链路任何环节抛错都**绝不回退重跑**（原生已执行成功后再回退 JS 会双写），
 *     且必须**补录失败 tool_result**——见 {@link StepToolExecutor.runToolCall}；
 *  3. native 路径与 JS 路径的「记录 / post 钩子」顺序不同（native 先记录后 post、
 *     JS 先 post 后记录），且写类工具成功后都要失效 repo-map 缓存；
 *  4. 每个 `tool_call` 事件都必须在同一批内落下配对的 `tool_result`——
 *     缺一条就会投影出「未被 `tool` 消息响应的 `assistant(tool_calls)`」，上游
 *     OpenAI/DeepSeek 兼容端点直接 HTTP 400（wire 层硬要求）。
 */
export class StepToolExecutor {
  /** 工具门禁（审批 + 沙箱 + 计划态 + 监督否决）：native 与 JS 路径共用。 */
  private readonly gate: ToolGatePort;
  /** 工具并行调度器（V2）：读类并行、写类屏障、model-order 提交。 */
  private readonly scheduler: ToolScheduler;
  /** 本回合的不可信来源追踪（SEC-03）：只在开启时生效。 */
  private provenance: ProvenanceTracker | undefined;
  /** 来源追踪模式（off/shadow/enforce；shadow 只记录不拦）。 */
  private provenanceMode: EnforcementMode = 'off';

  /**
   * @param deps 单步依赖契约（此处消费门禁相关字段：gate / approvals / sandbox / escalation /
   *   elevatedSandbox / tools / native / hooks / spiller / supervisor / promptInjectionGuard / workspaceRoot）。
   */
  public constructor(private readonly deps: StepRunnerDeps) {
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
    this.scheduler = new ToolScheduler();
    // (P4 升档) 注入护栏阈值覆盖：构造时把装配层透传的阈值注入 `ToolOutputTrust` 静态覆盖，
    // 使运行期可调「弱证据灵敏度」。缺省 undefined ⇒ 清覆盖回基线（零行为变更）。
    ToolOutputTrust.setThresholdOverride(deps.promptInjectionGuardThresholds ?? {});
  }

  /**
   * 执行本步全部工具调用（V2）：经 ToolScheduler 调度——读类并行（有界池）、
   * 写类屏障串行、结果按 model-order 提交。单工具执行/记录逻辑不变
   * （`runToolCall` 内部已自行记录结果，此处返回占位值仅为满足调度器签名，
   * ScheduledResult 不被消费）。
   *
   * @param calls 模型本步发出的工具调用（非空）。
   * @param context 工具上下文（含 sessionId）。
   * @returns 全部工具调用执行完毕后的 Promise（单个工具失败不抛出，已记录为失败结果）。
   */
  public async run(calls: readonly ToolCall[], context: ToolContext): Promise<void> {
    // V2 取消传播：本会话取消令牌的 AbortSignal 必须随工具上下文下传，否则长任务工具
    // （subagent / run_workflow / run_goal）无从得知父已取消，会继续派生并烧 token。
    const toolContext = this.withCancelSignal(context);
    const raw = process.env.OMNI_PROVENANCE_GUARD;
    this.provenanceMode =
      raw === undefined || raw === ''
        ? 'off'
        : raw === '1' || raw === 'true'
          ? 'enforce'
          : raw === '0' || raw === 'false'
            ? 'off'
            : EnforcementModeResolver.modeOf(raw);
    this.provenance = EnforcementModeResolver.observes(this.provenanceMode)
      ? ProvenanceTracker.fromEvents(this.deps.recorder.allEvents())
      : undefined;
    await this.scheduler.run(calls, async (call) => {
      const ok = await this.runToolCall(call, toolContext);
      return { callId: call.id, ok };
    });
  }

  /**
   * 把本步的取消信号注入工具上下文（V2 取消传播）。
   *
   * Agent 构造的工具上下文只带 sessionId/workspaceRoot，而取消信号在 `StepRunnerDeps.signal`
   * 上——两者在此汇合：工具层因此拿到「本会话取消令牌的 AbortSignal」，可把它下传子代。
   *
   * @param context 本步工具上下文
   * @returns 带取消信号的上下文；未注入信号或调用方已自带信号时原样返回
   */
  private withCancelSignal(context: ToolContext): ToolContext {
    const signal = this.deps.signal;
    if (signal === undefined || context.signal !== undefined) {
      return context;
    }
    return { ...context, signal };
  }

  /**
   * SEC-03：写类工具参数是否命中外部不可信来源片段；命中时记录配对拒绝事件。
   * @param call 工具调用。
   * @returns 命中并已记录拒绝时为 true。
   */
  private blockedByProvenance(call: ToolCall): boolean {
    if (
      this.provenance === undefined ||
      !MUTATING_TOOLS.has(call.name) ||
      !this.provenance.isTainted(call.arguments)
    ) {
      return false;
    }
    if (this.provenanceMode === 'shadow') {
      // shadow：跑检测、留证据，但原样放行（不伪造 tool_call/tool_result 配对）。
      log.warn('tool.provenance.shadow_blocked', { tool: call.name, callId: call.id });
      return false;
    }
    const reason =
      'SEC-03 来源追踪：该写类工具参数包含外部不可信工具输出片段，已拒绝（OMNI_PROVENANCE_GUARD=enforce）。';
    log.warn('tool.provenance.blocked', { tool: call.name, callId: call.id });
    this.deps.recorder.toolCall(call.id, call.name, call.arguments);
    this.deps.recorder.toolResult(call.id, false, undefined, reason);
    return true;
  }

  /**
   * 执行单个工具调用（审批 → 沙箱 → pre 钩子 → 执行 → post 钩子）。
   *
   * **配对不变量**：本方法一旦落下 `tool_call` 事件，就保证在同一批内落下配对的
   * `tool_result`（成功结果、门禁拒绝、或本方法兜底的失败结果三选一）。此前
   * `pre` 钩子/记录环节抛出的异常会被 {@link ToolScheduler} 的 `safeExecute` 转成
   * `failed ToolResult`，而调用点**丢弃返回值** ⇒ 事件日志留下孤儿 `tool_call`：
   * 投影出的 `assistant(tool_calls)` 含未被响应的 `tool_call_id`，上游端点 HTTP 400。
   *
   * **绝不回退重跑**：原生后端一旦「执行成功」（`runTool` 正常返回），此后记录/钩子
   * 再抛错也**不**回退 JS 路径——否则原生 + JS 各跑一次，写类工具双写、shell 双跑。
   *
   * @param call 单个工具调用。
   * @param context 工具上下文。
   * @returns 该调用是否成功（门禁拒绝、执行失败、链路异常均为 false）。
   */
  private async runToolCall(call: ToolCall, context: ToolContext): Promise<boolean> {
    // SEC-03：不可信来源片段进入写类工具参数 ⇒ enforce 时 fail-closed（shadow 只记录）。
    if (this.blockedByProvenance(call)) return false;
    // 审批 + 沙箱门禁（用户配置策略层）：native 与 JS 路径共用同一道门禁，
    // 保证 --approval / --sandbox 在两种后端下行为一致（修复 #66 旁路缺陷）。
    const denied = await this.gate.gate(call, context.sessionId);
    if (denied !== undefined) {
      log.warn('tool.denied', { tool: call.name, callId: call.id, error: denied.error });
      // 先记录 toolCall 事件：被拒工具若只留 tool_result（无对应 tool_call），ContextAssembler
      // 会产出 tool_call_id 悬空的 tool 消息，发给模型时触发 HTTP 400。补 toolCall 使配对合法。
      this.deps.recorder.toolCall(call.id, call.name, call.arguments);
      this.deps.recorder.toolResult(denied.callId, false, undefined, denied.error);
      return false;
    }
    log.info('tool.call', { tool: call.name, callId: call.id });
    this.deps.recorder.toolCall(call.id, call.name, call.arguments);
    const hookContext = {
      sessionId: context.sessionId,
      toolName: call.name,
      target: this.targetOf(call),
      args: call.arguments,
    };
    // 结果是否已落事件流：catch 里据此决定「补录失败结果」还是「只是重抛已记录的结果」。
    let recorded = false;
    try {
      // pre 钩子必须先于任何执行路径（native FFI / JS）：pre 的语义是「执行前拦截/审计」，
      // 放到执行之后就退化成事后通知，既拦不住也记不准。
      if (this.deps.hooks !== undefined) {
        await this.deps.hooks.pre(hookContext);
      }
      // FFI 热路径（#66）：pre 之后才真正执行；只接管 supports() 声明的语义等价工具。
      const nativeOutcome = await this.runNativeIfEquivalent(call, context, hookContext);
      if (nativeOutcome !== undefined) {
        return nativeOutcome;
      }
      const result = await this.deps.tools.execute(call, context);
      // 先记录真实结果、再跑 post 钩子（2026-10-01 审计，与 native 路径对齐）：
      // 写类/副作用类工具走到这里时**副作用已经落地**（文件已写、命令已跑）；
      // 若 post 钩子抛错走下方 catch，模型会看到「工具执行异常」并以过时假设重试，
      // supervisor 也会收到一条假失败信号推动误降级 —— 类头注释「post 失败不影响已成功
      // 的结果」说的就是这个顺序。
      await this.recordToolResult(call.name, result, context.sessionId);
      recorded = true;
      await this.runPostHookSafely(hookContext, call, result);
      // U4：写类工具成功执行后主动失效 repo-map 缓存（消除 30s TTL 陈旧窗口）。
      this.maybeInvalidateRepoMap(call, result);
      return result.ok;
    } catch (error) {
      if (!recorded) {
        // 兜底配对：链路异常（pre 钩子抛错 / 工具端口抛错 / 外溢落盘失败等）必须让模型
        // 看到一条失败结果，绝不留孤儿 tool_call（否则下一步请求 HTTP 400）。
        const message = error instanceof Error ? error.message : String(error);
        const text = `工具执行异常: ${message}`;
        log.warn('tool.call.failed', { tool: call.name, callId: call.id, error: message });
        this.deps.recorder.toolResult(call.id, false, undefined, text);
        if (!SupervisorHealthSignal.isPolicyDenial(text)) {
          this.deps.supervisor?.report(call.name, 'failure', text);
        }
      }
      return false;
    }
  }

  /**
   * 跑 post 钩子并隔离其异常（两条执行路径共用，调用方 `await` 保证时序不变）。
   *
   * post 钩子抛错时只告警、绝不改写已成功的结果：工具的副作用（文件写 / 命令执行）
   * 在此之前已经落地，把钩子异常谎报成「工具执行异常」会让模型以过时假设重试、
   * 并给监督内核一条假失败信号（2026-10-01 审计）。
   *
   * @param hookContext 钩子上下文（会话 / 工具名 / 目标 / 实参）。
   * @param call 工具调用（日志归因用）。
   * @param result 工具真实结果（原样交给钩子）。
   * @returns 无返回值（钩子异常被吞掉并留 `tool.hook.post.failed` 观测行）。
   */
  private async runPostHookSafely(
    hookContext: {
      sessionId: string;
      toolName: string;
      target: string;
      args: Record<string, unknown>;
    },
    call: ToolCall,
    result: ToolResult,
  ): Promise<void> {
    if (this.deps.hooks === undefined) {
      return;
    }
    try {
      await this.deps.hooks.post(hookContext, result);
    } catch (hookError) {
      const message = hookError instanceof Error ? hookError.message : String(hookError);
      log.warn('tool.hook.post.failed', { tool: call.name, callId: call.id, error: message });
    }
  }

  /**
   * U4：**明确会写工作区文件**的工具成功后主动失效 repo-map 缓存，消除 TTL 陈旧窗口。
   * fail-closed：workspaceRoot 未注入 / 工具未成功 / 非写文件工具 / 失效抛错，均静默跳过，绝不崩主流程。
   *
   * 为什么不用 `MUTATING_TOOLS`（2026-10-25）：后者含 `shell` / `run_code` / 子代理等
   * 「可能写盘但不可预知改了哪些文件」的工具，一次成功就会触发 `contentHashes()` 的
   * **全仓重读 + SHA1**（本机 1.0–2.4 s）。`shell` 在真实回合里频率最高（构建/测试/格式化），
   * 实测 20 次可白烧 24–48 s。现在这类工具交给 `fs.watch` 的脏标记 + TTL 复核；只有
   * `REPO_MAP_INVALIDATING_TOOLS`（write_file/edit/apply_patch/patch_candidates/rollback）立即失效。
   *
   * 仍走**软失效**（`invalidate`）而非硬删：未变则复用同一语料实例，真变才重建。
   *
   * @param call 已执行的工具调用。
   * @param result 该调用的结果（只读 ok）。
   * @returns 无返回值（失败静默）。
   */
  private maybeInvalidateRepoMap(call: ToolCall, result: { ok: boolean }): void {
    if (this.deps.workspaceRoot === undefined) {
      return;
    }
    if (!result.ok) {
      return;
    }
    if (!REPO_MAP_INVALIDATING_TOOLS.has(call.name)) {
      return;
    }
    try {
      this.deps.repoMapContext.invalidate(this.deps.workspaceRoot);
    } catch {
      // 缓存失效失败不影响主流程
    }
  }

  /**
   * 原生执行（仅当后端声明该工具语义等价时）。
   *
   * 2026-10-21：`--native` 默认开，而内核 fs.* 与 JS 工具语义不等价（offset/limit、行号、
   * 64 MiB 上限、.bak、mkdir -p、内容账本）。真实后端的 `supports()` 恒 false；
   * 未实现 `supports()` 的 stub 按「支持」处理，保持既有测试/嵌入方行为。
   * 根对账失败与内部失败都抛回调用方 → 回退 JS（其根恒正确）。
   * @param call 工具调用。
   * @param context 工具上下文。
   * @param hookContext 钩子上下文。
   * @returns 原生已处理时为 `ok`；未接管（不支持/内部失败）时 undefined。
   */
  private async runNativeIfEquivalent(
    call: ToolCall,
    context: ToolContext,
    hookContext: {
      sessionId: string;
      toolName: string;
      target: string;
      args: Record<string, unknown>;
    },
  ): Promise<boolean | undefined> {
    const native = this.deps.native;
    if (native === undefined || call.name === TOOL_NAMES.shell) return undefined;
    if (native.supports?.(call.name) === false) return undefined;
    let nativeResult: ToolResult | undefined;
    try {
      native.syncWorkspaceRoot?.(context.workspaceRoot);
      nativeResult = native.runTool(call);
    } catch {
      log.debug('tool.native.fallback', { tool: call.name, callId: call.id });
    }
    if (nativeResult === undefined) return undefined;
    await this.recordToolResult(call.name, nativeResult, context.sessionId);
    await this.runPostHookSafely(hookContext, call, nativeResult);
    this.maybeInvalidateRepoMap(call, nativeResult);
    return nativeResult.ok;
  }

  /**
   * 记录工具结果（#74）：超大输出先外溢为预览 + 定位符，避免撑爆上下文。
   *
   * @param toolName 工具名（外溢与监督上报用）。
   * @param result 原始工具结果。
   * @param sessionId 会话 id（外溢后端定位用）。
   * @returns 记录（含可选外溢 / 注入隔离 / 沙箱拒绝标注 / 监督上报）完成后的 Promise。
   */
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
    // (D1) 三态生效模式：off 不跑 / shadow 跑但不改行为 / enforce 跑且生效。
    const guardMode = EnforcementModeResolver.modeOf(this.deps.promptInjectionGuard);
    const guarded = EnforcementModeResolver.observes(guardMode)
      ? this.guardInjection(toolName, stored, guardMode)
      : stored;
    const annotated = this.annotateDenial(guarded);
    // 附件内存外置（2026-10-23）：大附件在**记录前**写盘，内存事件只留 `path`；
    // 模型下一次投影时由 `ContextAssembler` 按路径水合，UI 只显示 chip 名称。
    // 外置失败是优化失败而非功能失败：保留原 files，主流程照常。
    let files = result.files;
    const attachmentSpiller = this.deps.attachmentSpiller;
    if (attachmentSpiller !== undefined && files !== undefined && files.length > 0) {
      try {
        files = await attachmentSpiller.spillFiles(sessionId, files);
      } catch (error) {
        log.warn('tool.attachment.spill_failed', {
          tool: toolName,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.deps.recorder.toolResult(
      annotated.callId,
      annotated.ok,
      annotated.output,
      annotated.error,
      files,
    );
    // I-P0-3：工具执行成败上报监督内核（native + JS 全路径共用此处，覆盖完整）。
    // 策略拒绝（审批/沙箱/监督内核）不算工具健康失败：否则一次拒绝会推进 safe，
    // safe 又拒绝后续危险工具，形成自锁（实测长任务 3 小时循环）。
    // 命令「执行完但非零退出」同理不算（2026-10-27 真模型跑测）：一次红测试是日常中间态，
    // 不是工具坏了；判定用**原始结果**的 exitCode（外溢/注入护栏可能重建结果对象）。
    if (annotated.ok) {
      this.deps.supervisor?.report(toolName, 'success');
    } else if (!SupervisorHealthSignal.isPolicyDenial(annotated.error)) {
      if (SupervisorHealthSignal.isCommandOutcome(result)) {
        log.debug('tool.command.nonzero', { tool: toolName, exitCode: result.exitCode });
      } else {
        this.deps.supervisor?.report(toolName, 'failure', annotated.error);
      }
    }
  }

  /**
   * 提示注入护栏：工具结果 output 进模型上下文前做确定性扫描。
   *
   * - `enforce`：命中即隔离（替换为隔离标记，保留「已被拦截」信号，不把疑似注入喂给模型）；
   * - `shadow`：命中**只记不改**——写 `tool.injection.shadow` 告警但原样放行（D1：用于在生产
   *   流量上攒真实误报/漏报，弥补离线快照仅 32 例的度量不足）；
   * - `off`：本方法根本不被调用（见 `recordToolResult`）。
   *
   * P4：按工具名推断**来源信任级**并以之判定——外部抓取（web_search）弱证据即拦，
   * 本机命令输出（shell）需更强证据，以降低日志类误报。未登记工具回落 `unknown`（保守）。
   *
   * **兜底策略（D2）**：扫描器自身异常时**不再一律放行**。`enforce` 档 fail-closed 保守隔离
   * （否则「扫描器坏了」＝「护栏不存在」）；`shadow`/`off` 档原样返回以守住「不改行为」契约。
   * 策略抽成纯函数 `guardFailureResult` 以便单测。
   *
   * @param toolName 工具名（来源推断 + 命中告警用）。
   * @param result 原始（已可选外溢过的）工具结果。
   * @param mode 生效模式（`enforce` 改行为；`shadow` 只记录）。
   * @returns 按模式处理后的结果；扫描器异常时按 `guardFailureResult` 的兜底策略返回。
   */
  private guardInjection(toolName: string, result: ToolResult, mode: EnforcementMode): ToolResult {
    try {
      const guarded = PromptInjectionGuard.guardToolResult(
        result,
        ToolOutputTrust.fromToolName(toolName),
      );
      if (!guarded.blocked) {
        return guarded;
      }
      // (P4 升档) 用「是否强规则命中 + 弱证据策略」解析处置，替代旧版二值 `applies(mode)` 逻辑：
      //  - 非 enforce（off/shadow）：恒 'shadow'——只记不改（D1 观测档契约）；
      //  - enforce + 强规则命中：恒 'block'（高置信，无降级空间）；
      //  - enforce + 弱证据命中：由 weakPolicy 决定（'block' 隔离 / 'observe' 仅记不隔离）。
      const hasStrongHit = guarded.hits.some((hit) => hit.severity === 'strong');
      const disposition = EnforcementModeResolver.resolveInjectionDisposition(
        mode,
        hasStrongHit,
        this.deps.promptInjectionGuardWeakPolicy,
      );
      if (disposition === 'shadow') {
        log.warn('tool.injection.shadow', {
          tool: toolName,
          tier: guarded.tier,
          hits: guarded.hits.length,
        });
        return result;
      }
      if (disposition === 'observe') {
        // 弱证据降级：只记录不隔离（weakPolicy='observe'），牺牲部分弱证据拦截以降误伤。
        log.warn('tool.injection.observe', {
          tool: toolName,
          tier: guarded.tier,
          hits: guarded.hits.length,
        });
        return result;
      }
      log.warn('tool.injection', {
        tool: toolName,
        tier: guarded.tier,
        hits: guarded.hits.length,
      });
      return guarded;
    } catch {
      return PromptInjectionGuard.guardFailureResult(result, mode);
    }
  }

  /**
   * 执行期沙箱拒绝标注（G3）：若结果为失败且错误特征命中 OS 沙箱拒绝签名，
   * 前缀 [沙箱拒绝] 便于模型/可观测层识别"这是沙箱拦截而非一般错误"，进而决定是否提权重试。
   *
   * @param result 工具结果。
   * @returns 命中沙箱拒绝签名时带前缀的新结果；否则原样返回。
   */
  private annotateDenial(result: ToolResult): ToolResult {
    if (result.ok || result.error === undefined) {
      return result;
    }
    if (SandboxDenial.isLikelySandboxDenied({ message: result.error })) {
      return { ...result, error: `[沙箱拒绝] ${result.error}` };
    }
    return result;
  }

  /**
   * 提取动作目标（用于钩子/记录）。
   *
   * @param call 工具调用。
   * @returns command → path → 工具名 的优先顺序取值。
   */
  private targetOf(call: ToolCall): string {
    return String(call.arguments['command'] ?? call.arguments['path'] ?? call.name);
  }
}
