/**
 * `shell_interactive` 工具：在**真终端**里以前台直通方式跑交互式命令。
 *
 * ## 与 `shell` 工具的区别（别混用）
 *
 * | | `shell` | `shell_interactive` |
 * |---|---|---|
 * | stdio | 管道，输出捕获后回灌模型 | `inherit`，输出直接写在用户终端上 |
 * | 适用 | 构建/测试/grep 等非交互命令 | vim / htop / ssh / 交互式安装器等 TUI |
 * | 超时 | 默认 30s，可申请到 10 分钟 | 默认 10 分钟（交互式天然更久），可申请到 1 小时 |
 * | 无 TTY 时 | 照常走管道执行 | **fail-closed**（不静默退化成管道） |
 *
 * ## 为什么无 TTY 必须 fail-closed
 *
 * 一条交互式命令被接到管道上，最坏情况是「卡住等输入」把整轮 agent 挂死，最好情况也是
 * 行为与用户预期完全不同。故本工具在**无 TTY 且无 `script`** 时直接返回失败，并给出可执行原因
 * （去真终端里启动、或改用 `shell` 工具），而不是假装成功。
 *
 * 能力分级由 {@link PtyCapability} 单点负责，本类只做「校验 → 裁决 → 分级 → 执行 → 如实回传」。
 */
import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { log } from '../../../util/logger.js';
import { ShellCommandPolicy } from './shellCommandPolicy.js';
import { PtyCapability } from './ptyCapability.js';
import type { PtyProbe, PtyReport } from './ptyCapability.js';
import { ShellInteractiveExecutor } from './shellInteractiveExecutor.js';
import type { InteractiveRunOutcome } from './shellInteractiveExecutor.js';
import {
  SHELL_INTERACTIVE_DEFAULT_TIMEOUT_MS,
  SHELL_INTERACTIVE_MAX_TIMEOUT_MS,
  SHELL_MIN_TIMEOUT_MS,
} from './shellTimeouts.js';

/** `shell_interactive` 工具选项。 */
export interface ShellInteractiveToolOptions {
  /** 单条命令默认超时（毫秒），默认 600_000（10 分钟）。 */
  readonly timeoutMs?: number;
  /** 单条命令超时上限（毫秒），默认 3_600_000（1 小时）；调用方按次申请值会被钳制到 `[MIN, max]`。 */
  readonly maxTimeoutMs?: number;
  /** 命令文本长度上限（字符），默认 8192。 */
  readonly maxCommandLength?: number;
  /** 命令裁决器（纵深防御，可选）：返回错误说明即拒绝执行。 */
  readonly guard?: (command: string, context: ToolContext) => string | undefined;
  /** 工具层命令策略（默认 audit：解析并记录、不阻断）。 */
  readonly policy?: ShellCommandPolicy;
  /** PTY 探测输入（可选；测试注入以脱离真终端）。 */
  readonly probe?: PtyProbe | undefined;
  /** 执行器（缺省真 spawn + `stdio: 'inherit'`；测试可注入假实现）。 */
  readonly executor?: ShellInteractiveExecutor;
}

/**
 * 交互式 shell 工具：TTY 环境下以 `stdio: 'inherit'` 直通真终端。
 */
export class ShellInteractiveTool {
  /** 单次调用允许的最小超时（毫秒；与前台 shell 同族共用一口径）。 */
  public static readonly MIN_TIMEOUT_MS = SHELL_MIN_TIMEOUT_MS;

  /** 交互式默认超时（毫秒）：交互式会话天然比批处理久，故默认给 10 分钟。 */
  public static readonly DEFAULT_TIMEOUT_MS = SHELL_INTERACTIVE_DEFAULT_TIMEOUT_MS;

  /** 单次调用允许的最大超时（毫秒）：1 小时。 */
  public static readonly MAX_TIMEOUT_MS = SHELL_INTERACTIVE_MAX_TIMEOUT_MS;

  /** 工具层命令策略。 */
  private readonly policy: ShellCommandPolicy;
  /** 单条命令默认超时（毫秒）。 */
  private readonly timeoutMs: number;
  /** 单条命令超时上限（毫秒）。 */
  private readonly maxTimeoutMs: number;
  /** 命令文本长度上限（字符）。 */
  private readonly maxCommandLength: number;
  /** 可选命令裁决器。 */
  private readonly guard: ShellInteractiveToolOptions['guard'];
  /** PTY 探测输入。 */
  private readonly probe: PtyProbe | undefined;
  /** 交互式执行器。 */
  private readonly executor: ShellInteractiveExecutor;

  /**
   * @param options 工具选项（超时/长度上限、可选裁决器与策略、探测输入与执行器）。
   */
  public constructor(options: ShellInteractiveToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? ShellInteractiveTool.DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = Math.max(
      ShellInteractiveTool.MIN_TIMEOUT_MS,
      options.maxTimeoutMs ?? ShellInteractiveTool.MAX_TIMEOUT_MS,
    );
    this.maxCommandLength = options.maxCommandLength ?? 8192;
    this.guard = options.guard;
    this.policy = options.policy ?? new ShellCommandPolicy();
    this.probe = options.probe;
    this.executor = options.executor ?? new ShellInteractiveExecutor();
  }

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.shellInteractive,
    description:
      '在真实终端里以前台直通方式运行交互式命令（vim/htop/ssh/交互式安装器等 TUI）。' +
      '输出直接写在用户终端上、不回灌上下文，只回传真实退出码。' +
      '需要当前进程跑在真终端里；非 TTY 环境会明确失败（不静默退化为管道执行）。' +
      '非交互命令请改用 shell 工具。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的交互式命令（整体交给 shell 解释）。' },
        timeout_ms: {
          type: 'number',
          description:
            '本命令的超时毫秒数（默认 600000=10 分钟，会被钳制到 [1000, 3600000]）；' +
            '交互式会话按需调大，超时后子进程被强制终止。',
        },
      },
      required: ['command'],
    },
  };

  /**
   * 当前进程可用的交互式能力（供组合根 / 诊断命令如实报告「本机能不能交互」）。
   *
   * @returns PTY 分级探测结论。
   */
  public capability(): PtyReport {
    return PtyCapability.detect(this.probe ?? {});
  }

  /**
   * 执行交互式命令。
   *
   * @param call 工具调用（实参须含 command 字符串，可选 timeout_ms）。
   * @param context 工具上下文（workspaceRoot、sessionId 等）。
   * @returns 成功时 ok:true 且说明输出已直接写在终端上；命令为空/超长、被策略或裁决器拒绝、
   *   非 TTY 环境（fail-closed）、超时或非零退出时 ok:false（附可执行原因）。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const command = String(call.arguments['command'] ?? '').trim();
    if (command === '') {
      return this.failure(call.id, '命令为空');
    }
    if (command.length > this.maxCommandLength) {
      return this.failure(call.id, `命令过长（${command.length} > ${this.maxCommandLength} 字符）`);
    }
    const denied = this.policy.decide(command);
    if (denied !== undefined) {
      return this.failure(call.id, denied);
    }
    const denial = this.guard?.(command, context);
    if (denial !== undefined) {
      return this.failure(call.id, denial);
    }

    const report = this.capability();
    const argv = PtyCapability.argvOf(command, report);
    if (argv === null) {
      // fail-closed：无 TTY 且无 `script` ⇒ 明确失败，绝不退化成管道执行（那会让交互式命令挂死整轮）。
      return this.failure(call.id, report.reason);
    }

    const cwd = context.workspaceRoot !== '' ? context.workspaceRoot : undefined;
    if (cwd === undefined) {
      log.warn('shellInteractive.noWorkspaceRoot', {
        sessionId: context.sessionId,
        hint: '未注入 workspaceRoot，命令将继承进程工作目录',
      });
    }
    const timeoutMs = this.effectiveTimeout(call.arguments['timeout_ms']);
    try {
      const outcome = await this.executor.run(argv.bin, argv.args, {
        cwd,
        env: this.childEnv(),
        timeoutMs,
        // 转发会话取消（2026-09-26 审计 S12）：前台 shell 早已透传 `context.signal`，
        // 交互式这条支路漏了 ⇒ 撤销回合也停不下来，命令最长跑到 1 小时上限。
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      return this.toResult(call.id, report, outcome, timeoutMs);
    } catch (error) {
      return this.failure(call.id, error);
    }
  }

  /**
   * 把执行结果映射为工具结果（交互式没有输出可回灌，故只报状态）。
   *
   * @param callId 工具调用 ID。
   * @param report 本次使用的 PTY 探测结论（用于说明「在哪种终端里执行」）。
   * @param outcome 子进程执行结果。
   * @param timeoutMs 本次调用生效的超时（用于超时文案）。
   * @returns 工具结果（退出码如实回传）。
   */
  private toResult(
    callId: string,
    report: PtyReport,
    outcome: InteractiveRunOutcome,
    timeoutMs: number,
  ): ToolResult {
    const where = ShellInteractiveTool.describeMode(report);
    if (outcome.timedOut) {
      return {
        callId,
        ok: false,
        error: `交互式命令超时（${timeoutMs}ms，${where}），已终止子进程（输出直接写在终端上，未回灌上下文）`,
      };
    }
    if (outcome.signal !== null && outcome.exitCode === null) {
      return { callId, ok: false, error: `交互式命令被信号终止：${outcome.signal}（${where}）` };
    }
    if (outcome.exitCode !== 0) {
      return {
        callId,
        ok: false,
        error: `交互式命令退出码 ${outcome.exitCode ?? 'unknown'}（${where}）`,
      };
    }
    return {
      callId,
      ok: true,
      output: `交互式命令执行完成，退出码 0（${where}；输出直接写在用户终端上，未回灌上下文）。`,
    };
  }

  /**
   * 说明本次在哪种终端形态里执行（便于模型/用户归因）。
   *
   * @param report PTY 探测结论。
   * @returns 人话说明。
   */
  private static describeMode(report: PtyReport): string {
    return report.mode === 'pty-wrapper'
      ? 'GNU script 伪终端'
      : '继承的父进程终端（stdio: inherit）';
  }

  /**
   * 解析本次调用的生效超时：显式 `timeout_ms` 优先，钳制到 `[MIN, maxTimeoutMs]`；
   * 非法值（非数字/NaN/Infinity）一律回落默认，绝不把 NaN 透给定时器。
   *
   * @param requested 调用方请求的毫秒数（未知类型）。
   * @returns 生效超时毫秒数。
   */
  private effectiveTimeout(requested: unknown): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      return this.timeoutMs;
    }
    return Math.min(
      Math.max(Math.floor(requested), ShellInteractiveTool.MIN_TIMEOUT_MS),
      this.maxTimeoutMs,
    );
  }

  /**
   * 构造子进程环境：清除外部注入的 NODE_OPTIONS shim（与 `ShellTool.childEnv` 同一口径，
   * 否则交互式子进程会被代理的 fs hook 污染而行为不一致）。
   *
   * @returns 清理后的环境变量副本。
   */
  private childEnv(): NodeJS.ProcessEnv {
    const rawNodeOptions = process.env['NODE_OPTIONS'] ?? '';
    const cleanedNodeOptions = rawNodeOptions
      .split(/\s+/)
      .filter(
        (opt) =>
          opt !== '' && !/node-language-shim\.cjs|node-safe-delete|node-brokered-fs/i.test(opt),
      )
      .join(' ');
    return { ...process.env, NODE_OPTIONS: cleanedNodeOptions };
  }

  /**
   * 构造失败结果。
   *
   * @param callId 工具调用 ID。
   * @param error 失败原因（Error 或任意值）。
   * @returns ok:false 的工具结果。
   */
  private failure(callId: string, error: unknown): ToolResult {
    const detail = error instanceof Error ? error.message : String(error);
    return { callId, ok: false, error: detail };
  }
}
