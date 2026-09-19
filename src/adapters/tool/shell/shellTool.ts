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
import type { BackgroundJobRegistry } from './backgroundJobRegistry.js';
import { StackFrameParser } from '../verify/stackFrameParser.js';

/** shell 工具可选项。 */
export interface ShellToolOptions {
  /** 单条命令默认超时（毫秒），默认 30_000；调用方可经 `timeout_ms` 按次覆盖。 */
  readonly timeoutMs?: number;
  /**
   * 单条命令超时上限（毫秒），默认 600_000（10 分钟）。
   * 调用方传入的 `timeout_ms` 会被钳制到 `[MIN_TIMEOUT_MS, maxTimeoutMs]`——
   * 允许模型为 `tsc` / 全量测试这类长命令申请更多预算，同时防止单次调用把回合挂死。
   */
  readonly maxTimeoutMs?: number;
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
  /**
   * 后台作业注册表（P2-⑫，可选）：注入后 `background=true` 可用。
   * 未注入时该参数会返回明确失败（不静默退化成前台执行）。
   */
  readonly jobs?: BackgroundJobRegistry;
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
 * - **超时可按次申请但有上限**：默认 30s，模型可用 `timeout_ms` 为构建/测试类长命令申请更多预算，
 *   由 `maxTimeoutMs`（默认 10 分钟）封顶——既解掉原「30s 硬顶且不可覆盖」对 `tsc`/全量测试的封杀，
 *   又保留单次调用的最坏耗时上界；
 * - **失败可定位**（P1-⑩）：非零退出时从输出抽堆栈帧，把 `文件:行` 作为位置候选附在错误文案后；
 * - **可转后台**（P2-⑫）：`background=true` 交给 `BackgroundJobRegistry`，用 `shell_job` 取输出；
 * - 若 `workspaceRoot` 为空（调用方未注入），退回进程 cwd 并告警——已知宽松路径，
 *   收紧它属行为变更，需调用方显式确认后再开启。
 */
export class ShellTool {
  /** 单次调用允许的最小超时（毫秒）：低于此值等同于立即超时，没有意义。 */
  public static readonly MIN_TIMEOUT_MS = 1_000;

  /** 单次调用允许的最大超时（毫秒）：默认 10 分钟。 */
  public static readonly DEFAULT_MAX_TIMEOUT_MS = 600_000;

  /** 失败摘要中最多回灌的位置候选条数（P1-⑩，防刷屏）。 */
  private static readonly MAX_FRAME_HINTS = 5;

  /** 子进程输出解码器（处理 GBK/UTF-8 等编码容错）。 */
  private readonly decoder = new OutputDecoder();
  /** 子进程执行器（spawn 显式 argv）。 */
  private readonly runner = new ShellProcessRunner();
  /** 工具层命令策略。 */
  private readonly policy: ShellCommandPolicy;
  /** 单条命令默认超时（毫秒）。 */
  private readonly timeoutMs: number;
  /** 单条命令超时上限（毫秒），约束调用方按次覆盖值。 */
  private readonly maxTimeoutMs: number;
  /** stdout/stderr 各路上限（字节）。 */
  private readonly maxBufferBytes: number;
  /** 命令文本长度上限（字符）。 */
  private readonly maxCommandLength: number;
  /** 可选命令裁决器：返回错误说明即拒绝执行（未配置则不额外裁决）。 */
  private readonly guard: ShellToolOptions['guard'];
  /** 后台作业注册表（未注入时 `background=true` 明确失败）。 */
  private readonly jobs: BackgroundJobRegistry | undefined;

  /**
   * @param options shell 工具选项（超时/缓冲/长度上限、可选裁决器、策略与后台作业注册表，全有默认）。
   */
  public constructor(options: ShellToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxTimeoutMs = Math.max(
      ShellTool.MIN_TIMEOUT_MS,
      options.maxTimeoutMs ?? ShellTool.DEFAULT_MAX_TIMEOUT_MS,
    );
    this.maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
    this.maxCommandLength = options.maxCommandLength ?? 8192;
    this.guard = options.guard;
    this.policy = options.policy ?? new ShellCommandPolicy();
    this.jobs = options.jobs;
  }

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'shell',
    description:
      '在工作区内执行 shell 命令并返回输出（支持管道与重定向）。' +
      '构建、测试等长命令可用 timeout_ms 申请更长预算（默认 30000，上限 600000 毫秒）；' +
      '更久的任务用 background=true 转后台，配合 shell_job 取输出。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout_ms: {
          type: 'number',
          description:
            '本命令的超时毫秒数（默认 30000，会被钳制到 [1000, 600000]）；' +
            '跑构建或全量测试时按需调大，避免长命令被误杀。',
        },
        background: {
          type: 'boolean',
          description:
            'true 时立即返回并让命令在后台继续运行（输出写入日志文件），' +
            '之后用 shell_job 查看/终止。适合安装依赖、全量测试等分钟级任务。',
        },
      },
      required: ['command'],
    },
  };

  /**
   * 执行命令。
   *
   * @param call 工具调用（实参须含 command 字符串，可选 timeout_ms）。
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

    if (call.arguments['background'] === true) {
      return this.startBackground(call.id, command);
    }

    try {
      const timeoutMs = this.effectiveTimeout(call.arguments['timeout_ms']);
      const outcome = await this.runner.run(command, {
        cwd,
        env: this.childEnv(),
        timeoutMs,
        maxBufferBytes: this.maxBufferBytes,
      });
      return this.toResult(call.id, outcome, timeoutMs);
    } catch (error) {
      return this.failure(call.id, error);
    }
  }

  /**
   * 启动后台作业（P2-⑫）。
   *
   * 与前台路径的关系：**同样的策略裁决与裁决器已在上游执行过**（见 {@link handle} 的顺序），
   * 这里只负责把命令交给注册表并回报作业 id——不在后台路径上另做一套裁决，避免出现
   * 「前台拦、后台放」的旁路。
   *
   * @param callId 工具调用 ID。
   * @param command 已通过校验与裁决的命令文本。
   * @returns ok:true 并附作业 id 与取输出的用法；未注入注册表时 ok:false（不静默退化为前台）。
   */
  private startBackground(callId: string, command: string): ToolResult {
    if (this.jobs === undefined) {
      return this.failure(callId, '后台执行未启用（组合根未注入 BackgroundJobRegistry）');
    }
    try {
      const job = this.jobs.start(command, this.childEnv());
      return {
        callId,
        ok: true,
        output:
          `已在后台启动：${job.id}（pid ${job.pid === undefined ? '?' : String(job.pid)}）。\n` +
          `用 shell_job {action:"output", id:"${job.id}"} 取输出，{action:"status"} 看是否结束，` +
          `{action:"kill"} 终止。日志：${job.logFile}`,
      };
    } catch (error) {
      return this.failure(callId, error);
    }
  }

  /**
   * 解析本次调用的生效超时：显式 `timeout_ms` 优先，钳制到 `[MIN_TIMEOUT_MS, maxTimeoutMs]`。
   *
   * 非法值（非数字 / NaN / Infinity）一律回落默认超时——绝不把 NaN 透给定时器
   * （`setTimeout(NaN)` 会退化成 1ms，表现为「命令立刻超时」，极难归因）。
   *
   * @param requested 调用方请求的毫秒数（未知类型）。
   * @returns 生效超时毫秒数。
   */
  private effectiveTimeout(requested: unknown): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      return this.timeoutMs;
    }
    return Math.min(Math.max(Math.floor(requested), ShellTool.MIN_TIMEOUT_MS), this.maxTimeoutMs);
  }

  /**
   * 把执行结果映射为工具结果：状态优先级 超时 > 截断 > 退出码。
   *
   * @param callId 工具调用 ID。
   * @param outcome 子进程执行结果。
   * @param timeoutMs 本次调用生效的超时（用于超时文案，避免报默认值误导）。
   * @returns 工具结果（非零退出与超时都会保留已产生的输出）。
   */
  private toResult(callId: string, outcome: ShellRunOutcome, timeoutMs: number): ToolResult {
    const output = this.composeOutput(
      this.decoder.decode(outcome.stdout),
      this.decoder.decode(outcome.stderr),
    );
    if (outcome.timedOut) {
      return this.exitFailure(callId, `命令超时（${timeoutMs}ms）`, output);
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

  /**
   * 构造带输出的失败结果（非零退出/超时/截断路径，保留已产生输出供模型纠错）。
   *
   * P1-⑩：命令失败时从输出里抽堆栈帧，把 `文件:行` 作为**位置候选**附在错误文案后——
   * 模型不必再从 `npm ERR!`/`Traceback`/`panicked at` 的噪声里反推该改哪个文件的哪一行。
   * 无堆栈帧（或全是 `node_modules`/`node:internal` 噪声）时不附，避免制造假信号。
   *
   * @param callId 工具调用 ID。
   * @param message 失败说明。
   * @param output 已产生的组合输出。
   * @returns ok=false 的工具结果（有输出时一并带上）。
   */
  private exitFailure(callId: string, message: string, output: string): ToolResult {
    const hint = this.frameHint(output);
    const error = hint === '' ? message : `${message}\n${hint}`;
    return output === '' ? { callId, ok: false, error } : { callId, ok: false, error, output };
  }

  /**
   * 从命令输出解析位置候选（`文件:行`）。
   *
   * @param output 命令的组合输出（可能为空）。
   * @returns `位置候选（文件:行）：a:1、b:2` 形式的单行文本；无候选时返回空串。
   */
  private frameHint(output: string): string {
    if (output === '') {
      return '';
    }
    const locations = StackFrameParser.locate(output, ShellTool.MAX_FRAME_HINTS);
    return locations.length === 0 ? '' : `位置候选（文件:行）：${locations.join('、')}`;
  }
}
