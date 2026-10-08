/**
 * 自验证回环装饰器（P3）：包住 ToolPort，在「写类工具改了源码」后自动跑受限测试，
 * 把**失败摘要**回灌到该次工具结果里，让模型在同一步就拿到「改坏了」的信号。
 *
 * 设计取向（为什么不改主循环）：
 * 本仓库明确**不触碰热区**（`stepRunner` / `turnRunner` / `core/loop`）。自验证做成
 * `ToolPort` 装饰器后，零热区改动、由组合根一处装配即可生效，且天然可关（不装配=零行为）。
 *
 * 回灌纪律：
 *  - **只回灌失败摘要**（`TestFailureDigest` 限行），测试通过则**静默**（不制造无信息噪点）；
 *  - 摘要后会附**位置候选**（`StackFrameParser` 把堆栈帧解析成 `文件:行`，P1-⑩）；
 *  - **定向测试**（P1-⑨ 后半）：记住上次失败文件，下次用收窄命令先跑那一批，跑通即回归全量；
 *  - 假完成探测（可选注入，装配处用 `SelfChecklist`）同样只在其**未通过**时追加提示；
 *  - 全部预算（超时 / 输出上限 / 冷却 / 每会话次数）由 `SelfVerifyPolicy` 持有；
 *  - **fail-open**：命令未能执行、探测抛错等一律不改变原工具结果，绝不因自验证本身
 *    破坏主流程（与护栏的 fail-closed 取向不同——这里不是安全边界，是质量信号）。
 */
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { TestCommandRunner } from './testCommandRunner.js';
import { StackFrameParser } from './stackFrameParser.js';
import { TestFailureDigest } from './testFailureDigest.js';
import type { SelfVerifyPolicy } from './selfVerifyPolicy.js';
import type { DecisionEngine } from '../../../ports/decision/decisionEngine.js';
import type { DecisionTracePort } from '../../../ports/decision/decisionTrace.js';
import { VerdictTracer } from './verdictTracer.js';

import type { VerdictObservation, VerdictObserver } from './verdictTypes.js';
// verdict 观测类型已抽至 `./verdictTypes.ts`（中性模块），以打断
// `selfVerifyingToolPort ↔ verdictTracer` 循环依赖（架构门禁 [5]）。
export type { VerdictObservation, VerdictObserver };
/** 跑测试的结构化结果（供回灌文本与配对 trace 共用，避免二次推断真实结果）。 */
interface RunTestResult {
  /** 回灌文本；测试通过/未跑时为 undefined（静默）。 */
  readonly note: string | undefined;
  /** 测试命令是否实际执行（受预算/冷却约束可能未跑）。 */
  readonly ran: boolean;
  /** 测试是否通过（ran=false 时 undefined）。 */
  readonly passed: boolean | undefined;
  /** 测试退出码（ran=false 时 undefined；超时记为 undefined）。 */
  readonly exitCode: number | undefined;
  /** 是否超时。 */
  readonly timedOut: boolean;
}

/**
 * 假完成探测：检查刚写入的产物是否含未完成标记（如 TODO/TBD）。
 * 返回未完成原因（注入到回灌文本）；无问题时返回 `undefined`。
 */
export type FakeCompletionProbe = (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<string | undefined> | string | undefined;

/** 装饰器装配项（全部由组合根注入）。 */
export interface SelfVerifyWiring {
  /** 受控预算（命令 / 超时 / 输出上限 / 冷却 / 次数 / 摘要行数）。 */
  readonly policy: SelfVerifyPolicy;
  /** 工作区根（测试命令的 cwd）。 */
  readonly workspaceRoot: string;
  /** 受控命令执行器（生产用 `ShellTestCommandRunner`，单测注入替身）。 */
  readonly runner: TestCommandRunner;
  /** 触发器：该工具调用是否构成本回合的「改了源码」。 */
  readonly shouldVerify: (toolName: string, args: Readonly<Record<string, unknown>>) => boolean;
  /** 可选的假完成探测（装配处用 `SelfChecklist` 构造）。 */
  readonly probeFakeCompletion?: FakeCompletionProbe | undefined;
  /** 可注入时钟（单测用；缺省 `Date.now`）。 */
  readonly now?: (() => number) | undefined;
  /** 可选的决策引擎（Laya）：跑测试前做一次 noul 预判（System-1 廉价信号）。undefined 表示不接。 */
  readonly verdictPredictor?: DecisionEngine | undefined;
  /** 可选的 verdict 观测回调（shadow 档记录一致性，不阻断主流程）。 */
  readonly verdictObserver?: VerdictObserver | undefined;
  /** 决策引擎生效模式：shadow（仅经 observer 记 telemetry、不回灌）/ enforce（回灌预判供模型同一步使用）。缺省 undefined（不接 verdict 时）。 */
  readonly verdictMode?: 'shadow' | 'enforce' | undefined;
  /** 决策 trace 落盘端口（配对样本：noul 预判 vs 真实测试结果）。缺省 undefined（不落盘）。 */
  readonly verdictTrace?: DecisionTracePort | undefined;
}

/**
 * 自验证回环装饰器：透明转发 `ToolPort` 全部方法，仅在「改源码」调用后追加回灌。
 */
export class SelfVerifyingToolPort implements ToolPort {
  /**
   * 追踪的会话数上限（超出即按登记顺序淘汰最早的会话）。
   *
   * 依据：每条追踪项只是「已触发次数 + 最近时间 + 上次失败文件」三个小值，256 条足够覆盖
   * server 上的并发会话；上限存在的意义是把「每个见过的会话常驻一条」这条无界增长封死。
   */
  public static readonly MAX_TRACKED_SESSIONS = 256;

  /** 端口名（透传内层，保持审批/日志中的标识不变）。 */
  public readonly name: string;

  /**
   * 本会话**最近一次**自验证失败的可读摘要（成功即清除）。
   *
   * 供回合完成闸门（`TurnRunner` 的可选 `completionGate`）询问：模型声明「做完了」时，
   * 若这里仍有内容，说明它对源码的改动**验证未通过**却打算收尾 —— 闸门会把它回灌并再给一步
   * （有界，每回合至多一次）。返回 `undefined` 表示「最近一次验证通过」或「本会话没跑过」。
   * @param sessionId 会话 id。
   * @returns 失败摘要；无失败记录时为 undefined。
   */
  public lastFailure(sessionId: string): string | undefined {
    return this.lastFailureBySession.get(sessionId);
  }

  /** 被装饰的内层端口。 */
  private readonly inner: ToolPort;
  /** 装配项。 */
  private readonly wiring: SelfVerifyWiring;
  /** verdict 观测 + trace 落盘协作器（Laya 战略线；质量信号采集已从本装饰器抽离）。 */
  private readonly tracer: VerdictTracer;
  /** 每会话已触发的自验证次数（预算）。 */
  private readonly runs = new Map<string, number>();
  /** 每会话最近一次触发时间（冷却）。 */
  private readonly lastRunAt = new Map<string, number>();
  /** 每会话上次失败所指向的文件（供下次「定向测试」收窄命令，P1-⑨ 后半）。 */
  private readonly failingTargets = new Map<string, readonly string[]>();
  /**
   * 每会话**最近一次**自验证失败的摘要（成功即清除）。
   *
   * 存在理由（2026-09-26 审计 A1）：自验证此前只是**信号**（把摘要追加进工具结果），模型完全可以
   * 无视它直接说「做完了」。回合完成闸门（`TurnRunner`）需要问一句「本会话最近一次验证过了吗」，
   * 本表就是它的数据源。
   */
  private readonly lastFailureBySession = new Map<string, string>();

  /**
   * @param inner 被装饰的工具端口（生产为 `RegistryToolPort`）。
   * @param wiring 装配项（策略 / 执行器 / 触发器 / 可选探测）。
   */
  public constructor(inner: ToolPort, wiring: SelfVerifyWiring) {
    this.inner = inner;
    this.wiring = wiring;
    this.tracer = new VerdictTracer({
      predictor: wiring.verdictPredictor,
      observer: wiring.verdictObserver,
      mode: wiring.verdictMode,
      trace: wiring.verdictTrace,
      now: wiring.now ?? (() => Date.now()),
    });
    this.name = inner.name;
  }

  /**
   * 全部工具定义（透传）。
   *
   * @returns 内层端口的工具定义列表。
   */
  public list(): readonly ToolDefinition[] {
    return this.inner.list();
  }

  /**
   * 供模型上下文的工具子集（透传；内层不支持时回落 `list()`，与调用方缺省语义一致）。
   *
   * @returns 非 deferred 工具定义列表。
   */
  public listDirect(): readonly ToolDefinition[] {
    return this.inner.listDirect?.() ?? this.inner.list();
  }

  /**
   * 反注册工具（透传；内层不支持反注册时返回 false）。
   *
   * @param name 要反注册的工具名。
   * @returns 内层删除成功时为 true。
   */
  public unregister(name: string): boolean {
    return this.inner.unregister?.(name) ?? false;
  }

  /**
   * 执行工具调用，并在「写源码成功」后追加自验证回灌。
   *
   * @param call 工具调用。
   * @param context 工具上下文（读取 sessionId 以做每会话预算）。
   * @returns 内层结果；命中触发器且有回灌内容时，`output` 追加回灌段。
   */
  public async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const result = await this.inner.execute(call, context);
    if (!result.ok || !this.wiring.shouldVerify(call.name, call.arguments)) {
      return result;
    }
    const note = await this.afterSourceWrite(call, context);
    if (note === undefined) {
      return result;
    }
    const output = result.output === undefined ? note : `${result.output}\n\n${note}`;
    return { ...result, output };
  }

  /**
   * 写源码后的自验证：先做假完成探测（便宜），再按预算决定是否跑测试。
   *
   * @param call 本次工具调用（供探测读取参数）。
   * @param context 工具上下文（取 sessionId）。
   * @returns 回灌文本；无任何提示时为 `undefined`。
   */
  private async afterSourceWrite(
    call: ToolCall,
    context: ToolContext,
  ): Promise<string | undefined> {
    // Laya verdict 预判：跑测试前做一次 System-1 noul 预判。enforce 档把预判回灌进结果，
    // 供模型同一步拿到廉价信号；shadow 档仅经 observer 记 telemetry（见 VerdictTracer.observe）。
    // 决策引擎是质量信号，fail-open：预判不可用/退化时静默跳过，且不替代真实测试真值。
    const { noul, available } = await this.tracer.observe(call, context);
    const notes: string[] = [];
    if (this.tracer.mode === 'enforce' && noul !== undefined) {
      notes.push(
        `[自验证·Laya预判] System-1 预判本次源码改动会跑通既有测试的概率 p=${noul.toFixed(2)}（仅供参考，不替代真实测试结果）`,
      );
    }
    const fake = await this.probeFakeCompletion(call);
    if (fake !== undefined) {
      notes.push(`[自验证·假完成探测] ${fake}`);
    }
    let testRan = false;
    let testPassed: boolean | undefined;
    let testExitCode: number | undefined;
    if (this.allowRun(context.sessionId)) {
      this.recordRun(context.sessionId);
      const result = await this.runTests(context.sessionId);
      testRan = result.ran;
      testPassed = result.passed;
      testExitCode = result.exitCode;
      if (result.note !== undefined) {
        notes.push(result.note);
      }
    }
    // 配对 trace：预判（noul）与真实结果（testRan/testPassed/testExitCode）关联落盘，
    // 供离线 RLCD 温度校准与借鉴清单项训练。仅当 verdict 引擎启用（verdictMode 非空）时记录，
    // 避免无预判的噪声样本；落盘异常静默（fail-open）。
    this.tracer.emit(call, context, noul, available, testRan, testPassed, testExitCode);
    return notes.length > 0 ? notes.join('\n') : undefined;
  }

  /**
   * verdict 决策引擎的生效模式（`shadow` / `enforce` / undefined 表示未接）。
   *
   * 读出口存在的意义是**可断言**：本仓最高频缺陷形态是「配置声明了、装配层静默丢弃」，
   * 而「决策引擎到底有没有抵达自验证回环」在修补前只能靠读代码猜（2026-10 实测：CLI 与
   * 配置文件都没有引擎入口 ⇒ 恒不装配，1.7GB 权重零调用）。装配判据见
   * `tests/unit/decisionEngineWiring.test.ts`。
   * @returns 生效模式；未接 verdict 时为 undefined。
   */
  public get verdictMode(): 'shadow' | 'enforce' | undefined {
    return this.tracer.mode;
  }

  /**
   * 决策引擎是否真的抵达本装饰器（即 `verdictPredictor` 已注入）。
   * @returns 已注入为 true。
   */
  public get verdictReady(): boolean {
    return this.tracer.hasPredictor;
  }

  /**
   * 在受控预算内跑测试命令，失败/超时时产出回灌文本。
   *
   * 定向能力（P1-⑨ 后半）：本会话**上次**失败所指向的文件会被记住，本次改用
   * `policy.narrowedCommand(...)` 收窄命令——先跑失败的那批，而不是每次全量。
   * 跑通即清空收窄集（下次回到全量），避免「一直只跑子集」造成盲区。
   *
   * @param sessionId 会话 id（定向集按会话隔离）。
   * @returns 回灌文本；测试通过时为 `undefined`（静默）。
   */
  private async runTests(sessionId: string): Promise<RunTestResult> {
    const { policy, workspaceRoot, runner } = this.wiring;
    const command = policy.narrowedCommand(this.failingTargets.get(sessionId) ?? []);
    try {
      const outcome = await runner.run(
        command,
        workspaceRoot,
        policy.timeoutMs,
        policy.maxOutputBytes,
      );
      if (outcome.timedOut) {
        const note = `[自验证回环] 测试命令超时（${policy.timeoutMs}ms）：${command}。请先修复或缩小测试范围。`;
        this.lastFailureBySession.set(sessionId, note);
        return { note, ran: true, passed: false, exitCode: undefined, timedOut: true };
      }
      if (outcome.exitCode !== 0) {
        this.rememberFailing(sessionId, outcome.output);
        const digest = this.digestOf(outcome.output, policy.maxDigestLines);
        const note = `[自验证回环] 改动源码后自动跑测试未通过（exit=${String(outcome.exitCode)}）：${command}\n${digest}`;
        this.lastFailureBySession.set(sessionId, note);
        return {
          note,
          ran: true,
          passed: false,
          exitCode: outcome.exitCode ?? undefined,
          timedOut: false,
        };
      }
      this.failingTargets.delete(sessionId);
      this.lastFailureBySession.delete(sessionId);
      return { note: undefined, ran: true, passed: true, exitCode: 0, timedOut: false };
    } catch (error) {
      const note = `[自验证回环] 测试命令未能执行：${error instanceof Error ? error.message : String(error)}`;
      return { note, ran: false, passed: undefined, exitCode: undefined, timedOut: false };
    }
  }

  /**
   * 组织失败摘要：失败行 +（有则附）堆栈帧解析出的「位置候选」。
   *
   * 位置候选让模型**直接知道该改哪个文件的哪一行**，不必再从失败信息反推源码位置
   * （P1-⑩ 要补的最后一小段）。
   *
   * @param output 测试命令的原始输出。
   * @param maxDigestLines 摘要行数上限。
   * @returns 摘要文本（含位置候选段；无候选时不附）。
   */
  private digestOf(output: string, maxDigestLines: number): string {
    const digest = TestFailureDigest.from(output, maxDigestLines);
    const locations = StackFrameParser.locate(output);
    return locations.length === 0
      ? digest
      : `${digest}\n位置候选（文件:行）：${locations.join('、')}`;
  }

  /**
   * 记住本次失败所指向的文件，供下次定向测试收窄。
   *
   * @param sessionId 会话 id。
   * @param output 测试命令的原始输出。
   * @returns 无返回值（未解析到文件时清空该会话收窄集，退回全量命令）。
   */
  private rememberFailing(sessionId: string, output: string): void {
    const files = StackFrameParser.locate(output).map((frame) => frame.replace(/:\d+$/, ''));
    if (files.length === 0) {
      this.failingTargets.delete(sessionId);
      return;
    }
    this.failingTargets.set(sessionId, files);
  }

  /**
   * 运行假完成探测（失败静默：探测本身不得阻断主流程）。
   *
   * @param call 本次工具调用。
   * @returns 未完成原因；无探测或探测无误时为 `undefined`。
   */
  private async probeFakeCompletion(call: ToolCall): Promise<string | undefined> {
    const probe = this.wiring.probeFakeCompletion;
    if (probe === undefined) {
      return undefined;
    }
    try {
      return await probe(call.name, call.arguments);
    } catch {
      return undefined;
    }
  }

  /**
   * 是否允许本会话再跑一次测试（次数预算 + 冷却）。
   *
   * @param sessionId 会话 id。
   * @returns 允许触发时为 true。
   */
  private allowRun(sessionId: string): boolean {
    const runs = this.runs.get(sessionId) ?? 0;
    if (runs >= this.wiring.policy.maxRunsPerSession) {
      return false;
    }
    const last = this.lastRunAt.get(sessionId);
    return last === undefined || this.now() - last >= this.wiring.policy.cooldownMs;
  }

  /**
   * 记录一次触发（次数 + 时间戳）。
   *
   * @param sessionId 会话 id。
   * @returns 无返回值。
   */
  private recordRun(sessionId: string): void {
    this.runs.set(sessionId, (this.runs.get(sessionId) ?? 0) + 1);
    this.lastRunAt.set(sessionId, this.now());
    // 有界保留（2026-09-26 审计 S31）：`runs` / `lastRunAt` 原先按 sessionId 只写不删，
    // 长跑 server 里每见过一个会话就常驻一条（本文件的 `failingTargets` 有清理路径，这两个没有）。
    // Map 保持插入序，故按序淘汰最早登记的会话即可（预算/冷却只关心**当前**会话）。
    while (this.runs.size > SelfVerifyingToolPort.MAX_TRACKED_SESSIONS) {
      const oldest = this.runs.keys().next();
      if (oldest.done === true) break;
      this.runs.delete(oldest.value);
      this.lastRunAt.delete(oldest.value);
      this.failingTargets.delete(oldest.value);
      this.lastFailureBySession.delete(oldest.value);
    }
  }

  /**
   * 当前时间（可注入时钟）。
   *
   * @returns 毫秒时间戳。
   */
  private now(): number {
    return this.wiring.now?.() ?? Date.now();
  }
}
