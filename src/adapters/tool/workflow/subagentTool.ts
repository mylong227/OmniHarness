import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { SubagentOrchestrator } from '../../../subagent/subagentOrchestrator.js';
import type { SubagentResult } from '../../../subagent/subagentTypes.js';

/** 主会话派生子智能体时所在的深度（第一层子智能体为 1）。 */
const ROOT_DEPTH = 1;

/**
 * @beta
 * 子智能体工具：模型可派生一个进程内子智能体独立完成子任务。
 */
export class SubagentTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.subagent,
    description:
      '派生一个进程内子智能体独立完成子任务：独立会话、受限工具集、不可再派生子智能体。适合可并行的长任务或需要隔离上下文的试探性任务。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '子任务描述。需自包含——子智能体看不到主会话历史。',
        },
        tools: {
          type: 'array',
          description: '可选：授权给子智能体的工具名列表；不传则继承除 subagent 外的全部工具。',
        },
      },
      required: ['task'],
    },
  };

  /**
   * @param orchestrator 子智能体编排器（独立会话创建与受限工具注入均经它）。
   */
  public constructor(private readonly orchestrator: SubagentOrchestrator) {}

  /** 派生并执行子任务。
   * @param call 工具调用（实参含 task，可选 tools）。
   * @param context 工具上下文（取 sessionId 作为父会话；signal 为父会话取消信号）。
   * @returns 执行结果：成功附子智能体输出与元信息；缺 task、父已取消或子执行失败返回失败。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const task = String(call.arguments['task'] ?? '').trim();
    if (task === '') {
      return { callId: call.id, ok: false, error: '缺少子任务描述: task' };
    }
    const result = await this.orchestrator.run({
      task,
      parentSessionId: context.sessionId,
      depth: ROOT_DEPTH,
      tools: this.toolsOf(call),
      // 取消传播：父会话取消信号下传（父取消 → 子代模型请求中止、不再派生新子代）。
      signal: context.signal,
    });
    if (!result.ok) {
      return { callId: call.id, ok: false, error: result.error ?? '子智能体执行失败' };
    }
    return { callId: call.id, ok: true, output: this.render(result) };
  }

  /**
   * 渲染结果为带元信息的文本（子会话 ID 可回溯完整轨迹）。
   *
   * **必须显式标注「未完成」**（2026-09-26 审计 F10）：子代理被步数截断 / 失控熔断时，
   * 它依然带着一段兜底摘要返回；若不标注，父级会把「跑满预算」读成「已完成」，据此继续往下做。
   *
   * **必须显式标注「改动落在隔离工作树里」**（2026-10-03 第六轮修看板 §8.1）：子代理的写入
   * 不会进主工作区，原先连"改过什么"都不回传 ⇒ 父级会把"子代理说改好了"读成"已经改好了"。
   * @param result 子智能体运行结果。
   * @returns 首行元信息（会话 ID/步数/耗时 + 未完成标注 + 改动去向）+ 输出文本。
   */
  private render(result: SubagentResult): string {
    const status =
      result.truncated === true
        ? ' ⚠️ 未完成：达步数上限（结论可能不完整，建议拆小后重派或改由主会话继续）'
        : result.aborted === true
          ? ' ⚠️ 未完成：被失控熔断/取消'
          : '';
    const head = `[子智能体 ${result.sessionId}] ${result.steps} 步 / ${result.durationMs}ms${status}`;
    const writes = this.renderWrites(result);
    return writes === '' ? `${head}\n${result.output}` : `${head}\n${writes}\n${result.output}`;
  }

  /**
   * 渲染"子代理改动的去向"（无改动时返回空串）。
   * @param result 子智能体运行结果。
   * @returns 改动提示块（可能多行）。
   */
  private renderWrites(result: SubagentResult): string {
    if (result.writesForbidden === true) {
      return (
        'ℹ️ 本次子代理在**无 git 隔离**档（copy 降级）下运行，**写类工具已被禁用**：' +
        '它无法修改代码，若结论里出现"已修改"请视为不可信，改由主会话执行。'
      );
    }
    if (result.writesUnrecoverable === true) {
      return (
        '⚠️ 本次子代理**改动了文件但改动不可取回**（采集失败）。主工作区未被改动；' +
        '若结论里声称已修改代码，请勿当作已生效——改由主会话重做或重新派发。'
      );
    }
    const files = result.changedFiles ?? [];
    if (files.length === 0) {
      return '';
    }
    const truncation = result.patchTruncated === true ? '（patch 已截断，清单完整）' : '';
    const path = result.patchPath ?? '(未落盘)';
    return (
      `⚠️ 子代理在**隔离工作树**里改动了 ${String(files.length)} 个文件${truncation}，` +
      `**主工作区尚未改动**；patch 在 \`${path}\`，采纳请执行 \`git apply ${path}\`（或改由主会话重做）。\n` +
      `改动文件：${files.slice(0, 20).join('、')}${files.length > 20 ? ` …（共 ${String(files.length)} 个）` : ''}`
    );
  }

  /** 提取可选的工具白名单。
   * @param call 工具调用（实参可能含 tools 数组）。
   * @returns 合法工具名数组；未提供或全非法时为 undefined（继承默认集）。
   */
  private toolsOf(call: ToolCall): readonly string[] | undefined {
    const raw = call.arguments['tools'];
    if (!Array.isArray(raw)) {
      return undefined;
    }
    const names = raw.filter((entry): entry is string => typeof entry === 'string');
    return names.length > 0 ? names : undefined;
  }
}
