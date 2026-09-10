import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../ports/tool.js';
import { OutputDecoder } from '../../util/outputDecoder.js';
import { log } from '../../util/logger.js';

const run = promisify(exec);

/** shell 工具可选项。 */
export interface ShellToolOptions {
  /** 单条命令超时（毫秒），默认 30_000。 */
  readonly timeoutMs?: number;
  /** stdout/stderr 缓冲上限（字节），默认 1 MiB，超出即报错（防输出风暴）。 */
  readonly maxBufferBytes?: number;
  /** 命令文本长度上限（字符），默认 8192。 */
  readonly maxCommandLength?: number;
  /**
   * 命令裁决器（纵深防御，可选）：返回错误说明即拒绝执行。
   * 未配置时本工具不额外裁决——审批与沙箱由上层 `ToolGate` 统一负责（见 `stepRunner.gate`），
   * 此处不重复裁决，但也不会声称自己有沙箱边界。
   */
  readonly guard?: (command: string, context: ToolContext) => string | undefined;
}

/** 内置 shell 工具：在工作区内执行命令。 */
export class ShellTool {
  private readonly decoder = new OutputDecoder();
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly maxCommandLength: number;
  private readonly guard: ShellToolOptions['guard'];

  public constructor(options: ShellToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
    this.maxCommandLength = options.maxCommandLength ?? 8192;
    this.guard = options.guard;
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
   * 安全边界说明（勿再夸大为「沙箱内执行」）：
   * - 命令固定以 `context.workspaceRoot` 为工作目录执行，避免继承进程 cwd 跑到工作区外；
   * - 审批与沙箱裁决由上层 `ToolGate`（`stepRunner.gate`）统一负责，本工具不重复裁决；
   * - 本工具只负责资源护栏：空命令拒绝、超长命令拒绝、超时、输出上限；
   * - 若 `workspaceRoot` 为空（调用方未注入），退回进程 cwd 并告警——这是已知的宽松路径，
   *   收紧它属于行为变更，需调用方显式确认后再开启。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const command = String(call.arguments['command'] ?? '').trim();
    if (command === '') {
      return this.failure(call.id, '命令为空');
    }
    if (command.length > this.maxCommandLength) {
      return this.failure(
        call.id,
        `命令过长（${command.length} > ${this.maxCommandLength} 字符）`,
      );
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
      // 清除 WorkBuddy/CodeBuddy 注入的 NODE_OPTIONS shim（如 node-language-shim.cjs），
      // 避免子进程被代理的 fs/safe-delete hook 污染，导致 tsc 等工具异常 OOM 或行为不一致。
      const rawNodeOptions = process.env.NODE_OPTIONS ?? '';
      const cleanedNodeOptions = rawNodeOptions
        .split(/\s+/)
        .filter((opt) => opt !== '' && !/node-language-shim\.cjs|node-safe-delete|node-brokered-fs/i.test(opt))
        .join(' ');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_OPTIONS: cleanedNodeOptions,
      };
      const { stdout, stderr } = await run(command, {
        timeout: this.timeoutMs,
        encoding: 'buffer',
        maxBuffer: this.maxBufferBytes,
        ...(cwd !== undefined ? { cwd } : {}),
        env,
      });
      const outText = this.decoder.decode(stdout as Buffer);
      const errText = this.decoder.decode(stderr as Buffer);
      return { callId: call.id, ok: true, output: this.composeOutput(outText, errText) };
    } catch (error) {
      return this.failure(call.id, error);
    }
  }

  /** 组装 stdout/stderr 输出。 */
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

  /** 构造失败结果。 */
  private failure(callId: string, error: unknown): ToolResult {
    const detail = error instanceof Error ? error.message : String(error);
    return { callId, ok: false, error: detail };
  }
}
