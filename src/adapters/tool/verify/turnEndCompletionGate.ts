/**
 * 回合**结束时**的完成闸门执行器（2026-09-26 审计 A1 收口）。
 *
 * 与 `SelfVerifyingToolPort` 的分工：
 *  - 写时自验证（`selfVerify.enabled === true`）在**每次写源码后**跑一次，把失败摘要追加进工具结果；
 *  - 本类只在**回合结束、模型宣布完成**时跑一次 —— 因此它能在「用户没开写时自验证」的运行里
 *    仍然拦住「改坏了还宣布完成」。这正是 A1 原先的缺口：闸门只挂在写时自验证的产物上，
 *    没开就没有闸门。
 *
 * 三条边界（刻意如此，避免把增强做成陷阱）：
 *  1. **fail-open**：命令根本跑不起来（工具链缺失 / 超时 / 抛错）时不产出「失败摘要」⇒ 不拦收尾。
 *     闸门是**增强**，不该因为环境问题把正常回合卡死（真正的超时会如实回报为一条提示，让模型知道）。
 *  2. **每回合至多一次**由 `TurnRunner` 保证（它只问一次）。
 *  3. **只在「本回合确实改过文件」时触发**同样由 `TurnRunner` 判断（`kind === 'turn-end'`）。
 *
 * 2026-10-03 第五轮补第四道判据（**修 fail-open 漏洞**）：退出码为 0 **不再等于**验证通过——
 * `node --test` 在 glob 落空时打印 `# tests 0` 却以 0 退出（实测），于是「没跑任何测试」被判成
 * 「验证通过」。现由 {@link TestCountParser} 识别**显式零测试证据**并拦截（详见 `unverifiedOf`）。
 */

import { SelfVerifyPolicy } from './selfVerifyPolicy.js';
import { TestCountParser } from './testCountParser.js';
import { TestFailureDigest } from './testFailureDigest.js';
import { StackFrameParser } from './stackFrameParser.js';
import { ShellTestCommandRunner } from './shellTestCommandRunner.js';
import type { TestCommandRunner } from './testCommandRunner.js';

/** 构造依赖。 */
export interface TurnEndCompletionGateDeps {
  /** 验证策略（命令 / 超时 / 输出与摘要上限）。 */
  readonly policy: SelfVerifyPolicy;
  /** 工作区根（命令的 cwd）。 */
  readonly workspaceRoot: string;
  /** 命令执行器（缺省 `ShellTestCommandRunner`；可注入替身）。 */
  readonly runner?: TestCommandRunner | undefined;
  /** 进程环境（缺省 `process.env`；可注入）。 */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * 回合完成闸门：在回合末尾跑一次验证命令，未通过即返回可读摘要。
 */
export class TurnEndCompletionGate {
  /** 闸门种类（`TurnRunner` 据此决定是否要求「本回合改过文件」）。 */
  public readonly kind = 'turn-end' as const;

  /** 生效策略。 */
  private readonly policy: SelfVerifyPolicy;
  /** 工作区根。 */
  private readonly workspaceRoot: string;
  /** 命令执行器。 */
  private readonly runner: TestCommandRunner;

  /**
   * @param deps 策略、工作区根与可选执行器/环境。
   */
  public constructor(deps: TurnEndCompletionGateDeps) {
    this.policy = deps.policy;
    this.workspaceRoot = deps.workspaceRoot;
    this.runner = deps.runner ?? new ShellTestCommandRunner();
  }

  /**
   * 跑一次验证命令。
   * @param _sessionId 会话 id（本实现不使用；保留签名以匹配闸门契约）。
   * @returns 失败/超时的可读摘要；通过或无法执行时为 undefined（fail-open）。
   */
  public async verify(_sessionId: string): Promise<string | undefined> {
    const command = this.policy.command;
    try {
      const outcome = await this.runner.run(
        command,
        this.workspaceRoot,
        this.policy.timeoutMs,
        this.policy.maxOutputBytes,
      );
      if (outcome.timedOut) {
        return (
          `[完成闸门] 回合结束验证命令超时（${String(this.policy.timeoutMs)}ms）：${command}。` +
          '请缩小验证范围（例如只跑相关测试文件）后重试，或在结论里说明为何无法验证。'
        );
      }
      if (outcome.exitCode !== 0) {
        // 与写时自验证同一套摘要口径（失败行优先 + 位置候选），让模型拿到的信息量一致。
        const digest = TestFailureDigest.from(outcome.output, this.policy.maxDigestLines);
        const locations = StackFrameParser.locate(outcome.output);
        const withHints =
          locations.length === 0
            ? digest
            : `${digest}\n位置候选（文件:行）：${locations.join('、')}`;
        return `[完成闸门] 回合结束验证未通过（exit=${String(outcome.exitCode)}）：${command}\n${withHints}`;
      }
      return this.unverifiedOf(command, outcome.output);
    } catch {
      // fail-open：命令跑不起来（工具链缺失等）不拦收尾 —— 闸门是增强，不是环境检测器。
      return undefined;
    }
  }

  /**
   * 退出码为 0 时的**第二道判据**：零测试与"有失败但退出码为 0"都不算通过。
   *
   * 为什么必须补这一道（2026-10-03 第五轮）：`node --test` 在 glob 一条都没匹配到时
   * 打印 `# tests 0` 并**以 0 退出**（实测），本仓 `npm test` 正是
   * `npm run build && node --test "dist/tests/unit/*.test.js"` ⇒ 一旦路径漂移或构建产物缺失，
   * "没跑任何测试"会被原判据判成"验证通过"（假完成）。判据只认**显式零测试证据**，
   * 拿不到汇总行（日志被截断 / 命令不是测试运行器）时**不拦**，避免把增强做成环境检测器。
   * @param command 实际执行的命令（用于识别运行器）。
   * @param output 合并后的输出文本。
   * @returns 拦截文本；无证据时为 undefined（放行）。
   */
  private unverifiedOf(command: string, output: string): string | undefined {
    const counts = TestCountParser.parse(command, output);
    if (counts.zeroEvidence) {
      return (
        `[完成闸门] 回合结束验证命令**一条测试都没跑**（零测试 ≠ 通过，runner=${counts.runner}）：${command}\n` +
        '请确认验证命令的路径/过滤器没有落空（例如 glob 未匹配到任何测试文件、构建产物缺失），' +
        '并在结论里如实说明"未验证"或修好路径后重试。'
      );
    }
    if (counts.failed > 0) {
      return (
        `[完成闸门] 回合结束验证命令报告了 ${String(counts.failed)} 个失败用例，但退出码为 0：${command}\n` +
        `（解析：total=${String(counts.total)} passed=${String(counts.passed)} failed=${String(counts.failed)}）` +
        ' 退出码与计数不一致时以**计数**为准，请先查清为何未以非零退出。'
      );
    }
    return undefined;
  }
}
