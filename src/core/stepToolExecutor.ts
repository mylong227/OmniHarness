import type { ToolContext, ToolCall, ToolResult } from '../ports/tool/tool.js';
import { ToolGate, MUTATING_TOOLS } from './toolGate.js';
import { ToolScheduler } from './loop/toolScheduler.js';
import { isLikelySandboxDenied } from '../ports/runtime/sandboxDenial.js';
import { guardToolResult } from '../security/promptInjectionGuard.js';
import { ToolOutputTrust } from '../security/toolOutputTrust.js';
import { log } from '../util/logger.js';
import type { StepRunnerDeps } from './stepTypes.js';

/**
 * 单步「工具执行」协作者（从 `StepRunner` 按职责缝抽出，P6.3 上帝类收口）。
 *
 * 职责单一：把模型本步发出的工具调用，按
 * **门禁 → pre 钩子 → （native FFI | JS）执行 → post 钩子 → 结果记录** 的固定链路落地。
 *
 * 三条不可动的行为约束（抽类时逐字保留，均有实测背景）：
 *  1. `pre` 钩子必须先于任何执行路径——放到执行之后会退化为事后通知，既拦不住也记不准；
 *  2. `pre` 自身抛错直接向上抛，**绝不回退重跑**，否则写类工具会被执行两次；
 *  3. native 路径与 JS 路径的「记录 / post 钩子」顺序不同（native 先记录后 post、
 *     JS 先 post 后记录），且写类工具成功后都要失效 repo-map 缓存。
 */
export class StepToolExecutor {
  /** 工具门禁（审批 + 沙箱 + 计划态 + 监督否决）：native 与 JS 路径共用。 */
  private readonly gate: ToolGate;
  /** 工具并行调度器（V2）：读类并行、写类屏障、model-order 提交。 */
  private readonly scheduler: ToolScheduler;

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
    await this.scheduler.run(calls, async (call) => {
      await this.runToolCall(call, context);
      return { callId: call.id, ok: true };
    });
  }

  /**
   * 执行单个工具调用（审批 → 沙箱 → pre 钩子 → 执行 → post 钩子）。
   *
   * @param call 单个工具调用。
   * @param context 工具上下文。
   * @returns 该调用走完整条链路后的 Promise。
   */
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
    if (!MUTATING_TOOLS.has(call.name)) {
      return;
    }
    try {
      this.deps.repoMapContext.clear(this.deps.workspaceRoot);
    } catch {
      // 缓存失效失败不影响主流程
    }
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
    const guarded =
      this.deps.promptInjectionGuard === true ? this.guardInjection(toolName, stored) : stored;
    const annotated = this.annotateDenial(guarded);
    this.deps.recorder.toolResult(
      annotated.callId,
      annotated.ok,
      annotated.output,
      annotated.error,
      result.files,
    );
    // I-P0-3：工具执行成败上报监督内核（native + JS 全路径共用此处，覆盖完整）。
    this.deps.supervisor?.report(toolName, annotated.ok ? 'success' : 'failure', annotated.error);
  }

  /**
   * 提示注入护栏（opt-in）：工具结果 output 进模型上下文前做确定性扫描，命中即隔离
   * （替换为隔离标记，保留「已被拦截」信号，不把疑似注入喂给模型）。失败开放：guardToolResult
   * 异常时回落原始结果，不阻断主流程。
   *
   * P4：按工具名推断**来源信任级**并以之判定——外部抓取（web_search）弱证据即拦，
   * 本机命令输出（shell）需更强证据，以降低日志类误报。未登记工具回落 `unknown`（保守）。
   *
   * @param toolName 工具名（来源推断 + 命中告警用）。
   * @param result 原始（已可选外溢过的）工具结果。
   * @returns 隔离后的结果；护栏异常时回落原结果。
   */
  private guardInjection(toolName: string, result: ToolResult): ToolResult {
    try {
      const guarded = guardToolResult(result, ToolOutputTrust.fromToolName(toolName));
      if (guarded.blocked) {
        log.warn('tool.injection', {
          tool: toolName,
          tier: guarded.tier,
          hits: guarded.hits.length,
        });
      }
      return guarded;
    } catch {
      return result;
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
    if (isLikelySandboxDenied({ message: result.error })) {
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
