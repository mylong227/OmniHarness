import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { BackgroundJob } from './backgroundJobRegistry.js';
import { BackgroundJobRegistry } from './backgroundJobRegistry.js';

/** `shell_job` 的合法动作。 */
const ACTIONS = ['list', 'status', 'output', 'kill'] as const;

/** 单次取日志尾部的默认字节数（32 KiB）。 */
const DEFAULT_OUTPUT_BYTES = 32_768;

/** 单次取日志尾部的上限（256 KiB，防一次把上下文灌满）。 */
const MAX_OUTPUT_BYTES = 262_144;

/**
 * 后台作业管理工具（P2-⑫）：配合 `shell(background=true)` 使用。
 *
 * 四个动作覆盖长时命令的完整生命周期：`list` 看有哪些在跑、`output` 取增量输出、
 * `status` 看是否结束与退出码、`kill` 终止。
 */
export class ShellJobTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.shellJob,
    description:
      '管理后台作业（配合 shell 的 background=true 使用）。' +
      'action=output 取日志尾部，status 看状态/退出码，kill 终止，list 列出全部。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: '要执行的动作' },
        id: { type: 'string', description: '作业 id（除 list 外必填，形如 bg-1）' },
        max_bytes: {
          type: 'number',
          description: `output 动作取日志尾部的字节数（默认 ${DEFAULT_OUTPUT_BYTES}，上限 ${MAX_OUTPUT_BYTES}）`,
        },
      },
      required: ['action'],
    },
  };

  /**
   * @param jobs 后台作业注册表（与 `shell` 工具**共用同一实例**，否则查不到彼此启的作业）。
   */
  public constructor(private readonly jobs: BackgroundJobRegistry) {}

  /**
   * 执行作业管理动作。
   *
   * @param call 工具调用（含 action，除 list 外还需 id）。
   * @param _context 工具上下文（本工具不依赖，保留签名兼容）。
   * @returns 动作结果；参数非法或作业不存在时返回 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const action = String(call.arguments['action'] ?? '').trim();
    if (action === 'list') {
      return { callId: call.id, ok: true, output: this.renderList() };
    }
    const id = String(call.arguments['id'] ?? '').trim();
    if (id === '') {
      return { callId: call.id, ok: false, error: `action=${action} 需要 id（形如 bg-1）` };
    }
    switch (action) {
      case 'status':
        return this.renderStatus(call.id, id);
      case 'output':
        return this.renderOutput(call.id, id, call.arguments['max_bytes']);
      case 'kill':
        return this.renderKill(call.id, id);
      default:
        return {
          callId: call.id,
          ok: false,
          error: `未知 action: ${action}（可用 ${ACTIONS.join('/')}）`,
        };
    }
  }

  /**
   * 渲染作业清单。
   *
   * @returns 清单文本（无作业时给出明确说明）。
   */
  private renderList(): string {
    const jobs = this.jobs.list();
    if (jobs.length === 0) {
      return '当前没有后台作业（用 shell 的 background=true 启动）。';
    }
    return jobs.map((job) => this.describe(job)).join('\n');
  }

  /**
   * 渲染单个作业状态。
   *
   * @param callId 工具调用 ID。
   * @param id 作业 id。
   * @returns 状态文本；作业不存在时 ok:false。
   */
  private renderStatus(callId: string, id: string): ToolResult {
    const job = this.jobs.status(id);
    return job === undefined
      ? { callId, ok: false, error: `未找到作业 ${id}` }
      : { callId, ok: true, output: this.describe(job) };
  }

  /**
   * 渲染作业日志尾部。
   *
   * @param callId 工具调用 ID。
   * @param id 作业 id。
   * @param maxBytes 请求的字节数（非法值回落默认）。
   * @returns 日志尾部文本；作业不存在时 ok:false。
   */
  private renderOutput(callId: string, id: string, maxBytes: unknown): ToolResult {
    const cap = ShellJobTool.clampBytes(maxBytes);
    const text = this.jobs.output(id, cap);
    if (text === undefined) {
      return { callId, ok: false, error: `未找到作业 ${id}` };
    }
    const job = this.jobs.status(id);
    const head = job === undefined ? '' : `${this.describe(job)}\n`;
    return {
      callId,
      ok: true,
      output:
        text === ''
          ? `${head}（暂无输出）`
          : `${head}日志尾部（最多 ${String(cap)} 字节）：\n${text}`,
    };
  }

  /**
   * 终止作业。
   *
   * @param callId 工具调用 ID。
   * @param id 作业 id。
   * @returns 终止结果。
   */
  private renderKill(callId: string, id: string): ToolResult {
    return this.jobs.kill(id)
      ? { callId, ok: true, output: `已向作业 ${id} 发送终止信号。` }
      : { callId, ok: false, error: `未找到作业 ${id}，或该作业没有可终止的 pid` };
  }

  /**
   * 单行描述一个作业。
   *
   * @param job 作业快照。
   * @returns `id [状态] pid 已运行时长: 命令` 形式文本。
   */
  private describe(job: BackgroundJob): string {
    const elapsed = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
    const exit = job.exitCode === null ? '' : ` exit=${String(job.exitCode)}`;
    return `${job.id} [${job.status}${exit}] pid=${job.pid === undefined ? '?' : String(job.pid)} 已运行 ${String(elapsed)}s: ${job.command}`;
  }

  /**
   * 钳制请求的字节数到 `[1, MAX_OUTPUT_BYTES]`（非法值回落默认）。
   *
   * @param requested 请求值（未知类型）。
   * @returns 生效字节数。
   */
  private static clampBytes(requested: unknown): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      return DEFAULT_OUTPUT_BYTES;
    }
    return Math.min(Math.max(Math.floor(requested), 1), MAX_OUTPUT_BYTES);
  }
}
