import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { OutputDecoder } from '../../../util/outputDecoder.js';
import { log } from '../../../util/logger.js';
import { ShellCommandPolicy } from './shellCommandPolicy.js';
import { ShellProcessRunner } from './shellProcessRunner.js';
import type { ShellRunOutcome } from './shellProcessRunner.js';

/** shell 工具可选项。 */
export interface ShellToolOptions {
  /** 单条命令超时（毫秒），默认 30_000。 */
  readonly timeoutMs?: number;
  /** stdout/stderr 各路上限（字节），默认 1 MiB，超出即终止并报错（防输出风暴）。 */
  readonly maxBufferBytes?: number;
  /** 命令文本长度上限（字符），默认 8192。 */
  readonly maxCommandLength?: number;
  /**
   * 命令裁决器（纵深防御，可选）：返回错误说明即拒绝执行。
   * 与 {@link ShellToolOptions.policy} 并存——本项是**调用方注入**的一次性裁决，
   * `policy` 是结构化的工具层策略。未配置时本工具不额外裁决此处。
   */
  readonly guard?: (command: string, context: ToolContext) => string | undefined;
  /** 工具层命令策略（默认 audit 模式：解析并记录、不阻断；`enforce` 模式命中即拒）。 */
  readonly policy?: ShellCommandPolicy;
}

/**
 * 内置 shell 工具：在工作区内执行命令。
 *
 * A3 之后的**工具层纵深**（不再只是「上层有门禁、本层零纵深」）：
 * 1. 结构化解析：命令被解析为段/程序/重定向/命令替换（`ShellCommandParser`），不可判定即 fail-closed；
 * 2. 策略裁决：`ShellCommandPolicy` 按 deny/allow 名单与命令替换开关判定，默认 audit（记录不阻断）；
 * 3. 显式执行：`ShellProcessRunner` 用 `spawn` 回传**真实退出码/信号/超时/截断**状态。
 *
 * 安全边界（勿再夸大为「沙箱内执行」）：
 * - 命令固定以 `context.workspaceRoot` 为工作目录执行，避免继承进程 cwd 跑到工作区外；
 * - 审批与 OS 沙箱裁决由上层 `ToolGate`（`stepRunner.gate`）统一负责，本工具的裁决**不替代**它；
 * - 执行形态仍是 shell 解释器 + 命令文本（管道/重定向是本工具的对外契约）；
 * - 若 `workspaceRoot` 为空（调用方未注入），退回进程 cwd 并告警——已知宽松路径，
 *   收紧它属行为变更，需调用方显式确认后再开启。
 */
export class ShellTool {
  /** 子进程输出解码器（处理 GBK/UTF-8 等编码容错）。 */
  private readonly decoder = new OutputDecoder();
  /** 子进程执行器（spawn 显式 argv）。 */
  private readonly runner = new ShellProcessRunner();
  /** 工具层命令策略。 */
  private readonly policy: ShellCommandPolicy;
  /** 单条命令超时（毫秒）。 */
  private readonly timeoutMs: number;
  /** stdout/stderr 各路上限（字节）。 */
  private readonly maxBufferBytes: number;
  /** 命令文本长度上限（字符）。 */
  private readonly maxCommandLength: number;
  /** 可选命令裁决器：返回错误说明即拒绝执行（未配置则不额外裁决）。 */
  private readonly guard: ShellToolOptions['guard'];

  /**
   * @param options shell 工具选项（超时/缓冲/长度上限、可选裁决器与策略，全有默认）。
   */
  public constructor(options: ShellToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
    this.maxCommandLength = options.maxCommandLength ?? 8192;
    this.guard = options.guard;
    this.policy = options.policy ?? new ShellCommandPolicy();
  }

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'shell',
    description: '在工作区内执行 shell 命令并返回输出（支持管道与重定向）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
      },
      required: ['command'],
    },
  };

  /**
   * 执行命令。
   *
   * @param call 工具调用（实参须含 command 字符串）。
   * @param context 工具上下文（workspaceRoot、sessionId 等）。
   * @returns 执行结果：成功附 stdout/stderr 组合输出；校验失败、被裁决、超时、输出超限或
   *   命令非零退出时失败（非零退出与超时会**保留已产生的输出**，便于模型自行纠错）。
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

    const cwd = context.workspaceRoot !== '' ? context.workspaceRoot : undefined;
    if (cwd === undefined) {
      log.warn('shell.noWorkspaceRoot', {
        sessionId: context.sessionId,
        hint: '未注入 workspaceRoot，命令将继承进程工作目录',
      });
    }

    try {
      const outcome = await this.runner.run(command, {
        cwd,
        env: this.childEnv(),
        timeoutMs: this.timeoutMs,
        maxBufferBytes: this.maxBufferBytes,
      });
      return this.toResult(call.id, outcome);
    } catch (error) {
      return this.failure(call.id, error);
    }
  }

  /**
   * 把执行结果映射为工具结果：状态优先级 超时 > 截断 > 退出码。
   *
   * @param callId 工具调用 ID。
   * @param outcome 子进程执行结果。
   * @returns 工具结果（非零退出与超时都会保留已产生的输出）。
   */
  private toResult(callId: string, outcome: ShellRunOutcome): ToolResult {
    const output = this.composeOutput(
      this.decoder.decode(outcome.stdout),
      this.decoder.decode(outcome.stderr),
    );
    if (outcome.timedOut) {
      return this.exitFailure(callId, `命令超时（${this.timeoutMs}ms）`, output);
    }
    if (outcome.overflowed) {
      return this.exitFailure(
        callId,
        `输出超出上限（${this.maxBufferBytes} 字节），已终止命令`,
        output,
      );
    }
    if (outcome.signal !== null && outcome.exitCode === null) {
      return this.exitFailure(callId, `命令被信号终止：${outcome.signal}`, output);
    }
    if (outcome.exitCode !== 0) {
      return this.exitFailure(callId, `命令退出码 ${outcome.exitCode ?? 'unknown'}`, output);
    }
    return { callId, ok: true, output };
  }

  /**
   * 构造子进程环境：清除 WorkBuddy/CodeBuddy 注入的 NODE_OPTIONS shim
   * （如 node-language-shim.cjs），避免子进程被代理的 fs/safe-delete hook 污染，
   * 导致 tsc 等工具异常 OOM 或行为不一致。
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

  /** 组装 stdout/stderr 输出。
   * @param stdout 解码后的标准输出。
   * @param stderr 解码后的标准错误。
   * @returns 组合文本：stdout 在前，stderr 以 `[stderr]` 前缀追加。
   */
  private composeOutput(stdout: string, stderr: string): string {
    const parts: string[] = [];
    if (stdout !== '') {
      parts.push(stdout);
    }
    if (stderr !== '') {
      parts.push(`[stderr] ${stderr}`);
    }
    return parts.join('\n');
  }

  /** 构造失败结果（仅错误文案，无输出）。
   * @param callId 工具调用 ID。
   * @param error 抛出的错误（Error 或任意值）。
   * @returns ok=false 的工具结果（错误消息已提取）。
   */
  private failure(callId: string, error: unknown): ToolResult {
    const detail = error instanceof Error ? error.message : String(error);
    return { callId, ok: false, error: detail };
  }

  /** 构造带输出的失败结果（非零退出/超时/截断路径，保留已产生输出供模型纠错）。
   * @param callId 工具调用 ID。
   * @param message 失败说明。
   * @param output 已产生的组合输出。
   * @returns ok=false 的工具结果（有输出时一并带上）。
   */
  private exitFailure(callId: string, message: string, output: string): ToolResult {
    return output === ''
      ? { callId, ok: false, error: message }
      : { callId, ok: false, error: message, output };
  }
}
