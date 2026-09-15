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
import { TestFailureDigest } from './testFailureDigest.js';
import type { SelfVerifyPolicy } from './selfVerifyPolicy.js';

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
}

/**
 * 自验证回环装饰器：透明转发 `ToolPort` 全部方法，仅在「改源码」调用后追加回灌。
 */
export class SelfVerifyingToolPort implements ToolPort {
  /** 端口名（透传内层，保持审批/日志中的标识不变）。 */
  public readonly name: string;

  /** 被装饰的内层端口。 */
  private readonly inner: ToolPort;
  /** 装配项。 */
  private readonly wiring: SelfVerifyWiring;
  /** 每会话已触发的自验证次数（预算）。 */
  private readonly runs = new Map<string, number>();
  /** 每会话最近一次触发时间（冷却）。 */
  private readonly lastRunAt = new Map<string, number>();

  /**
   * @param inner 被装饰的工具端口（生产为 `RegistryToolPort`）。
   * @param wiring 装配项（策略 / 执行器 / 触发器 / 可选探测）。
   */
  public constructor(inner: ToolPort, wiring: SelfVerifyWiring) {
    this.inner = inner;
    this.wiring = wiring;
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
    const notes: string[] = [];
    const fake = await this.probeFakeCompletion(call);
    if (fake !== undefined) {
      notes.push(`[自验证·假完成探测] ${fake}`);
    }
    if (this.allowRun(context.sessionId)) {
      this.recordRun(context.sessionId);
      const testNote = await this.runTests();
      if (testNote !== undefined) {
        notes.push(testNote);
      }
    }
    return notes.length > 0 ? notes.join('\n') : undefined;
  }

  /**
   * 在受控预算内跑测试命令，失败/超时时产出回灌文本。
   *
   * @returns 回灌文本；测试通过时为 `undefined`（静默）。
   */
  private async runTests(): Promise<string | undefined> {
    const { policy, workspaceRoot, runner } = this.wiring;
    try {
      const outcome = await runner.run(
        policy.command,
        workspaceRoot,
        policy.timeoutMs,
        policy.maxOutputBytes,
      );
      if (outcome.timedOut) {
        return `[自验证回环] 测试命令超时（${policy.timeoutMs}ms）：${policy.command}。请先修复或缩小测试范围。`;
      }
      if (outcome.exitCode !== 0) {
        const digest = TestFailureDigest.from(outcome.output, policy.maxDigestLines);
        return `[自验证回环] 改动源码后自动跑测试未通过（exit=${String(outcome.exitCode)}）：${policy.command}\n${digest}`;
      }
      return undefined;
    } catch (error) {
      return `[自验证回环] 测试命令未能执行：${error instanceof Error ? error.message : String(error)}`;
    }
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
