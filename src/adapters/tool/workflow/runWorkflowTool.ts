import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';

import {
  WorkflowRunner,
  DEFAULT_WORKFLOW_CONCURRENCY,
  WorkflowCycleError,
  WorkflowSpecError,
} from '../../../autonomy/workflowRunner.js';
import { WorkflowStepStatuses } from '../../../autonomy/workflowTypes.js';
import type { WorkflowDef, WorkflowResult } from '../../../autonomy/workflowTypes.js';
import { RUN_WORKFLOW_TOOL_NAME } from '../../../autonomy/workflowToolNames.js';
import type { SubagentPortsShape } from '../../../ports/subagent/subagentPortsShape.js';

/** 模型面 run_workflow 工具：派生一次进程内 DAG 工作流（多步依赖编排 + 受控条件 + 断点续跑）。 */
export class RunWorkflowTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: RUN_WORKFLOW_TOOL_NAME,
    description:
      '派生一次进程内 DAG 工作流：多步任务按依赖关系并发编排，前序产出注入后续步骤。适合可拆成有依赖的子任务、需并行推进的复合任务。' +
      '步骤可用 when 声明受控条件（仅当某依赖步骤处于 done/failed/skipped 时才执行，用于补救/分支）；' +
      '运行会落盘运行日志，失败或中断后可用 resume 传上次的 runId 续跑（已完成的步骤复用产出，不再重跑）。',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description:
            '工作流定义：{ steps: [{ id, prompt, dependsOn?, tools?, writes?, when? }], maxConcurrency?, name? }。' +
            'dependsOn 为依赖的步骤 id 列表；when 形如 { step:"<dep id>", status:"done|failed|skipped", outputMatches?:"<正则>" }，' +
            '其 step 必须同时出现在本步 dependsOn 中；条件不满足该步记为「条件未满足（设计内跳过）」且不阻断下游。',
        },
        resume: {
          type: 'string',
          description:
            '续跑上次运行的 runId（来自上次结果首行）。给出时 spec 可省略（定义从运行日志读回）。',
        },
      },
      required: [],
    },
  };

  /**
   * @param ports 子智能体端口束（工作流各步骤以受限会话运行所需依赖）。
   */
  public constructor(private readonly ports: SubagentPortsShape) {}

  /** 校验并运行（或续跑）工作流。
   * @param call 工具调用（实参含 spec 工作流定义，或 resume＝续跑的 runId）。
   * @param context 工具上下文（本工具读其 signal：父会话取消信号，用于下传子步）。
   * @returns 执行结果：spec 非法/含环/规格与 runId 不匹配/步骤失败/父取消返回失败；成功附各步骤结果渲染文本。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const resumeArg = call.arguments['resume'];
    const spec = call.arguments['spec'];
    if (resumeArg !== undefined && typeof resumeArg !== 'string') {
      return { callId: call.id, ok: false, error: 'resume 必须是字符串（上次结果的 runId）' };
    }
    if (resumeArg === undefined && !this.isWorkflowSpec(spec)) {
      return { callId: call.id, ok: false, error: '缺少工作流定义: spec.steps（数组）' };
    }
    const def = this.isWorkflowSpec(spec) ? (spec as WorkflowDef) : undefined;
    if (def !== undefined && def.steps.length === 0) {
      return { callId: call.id, ok: false, error: '工作流至少需包含一个步骤' };
    }
    try {
      const runner = new WorkflowRunner(this.ports, {
        // 非法 maxConcurrency 由 WorkflowRunner 构造期 fail-closed 拒绝（下方 catch 转为工具错误），
        // 绝不留给并发闸门永久挂起。
        maxConcurrency: def?.maxConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY,
        // 取消传播：父会话取消 → 不再启动新步骤，在飞步骤的模型请求一并中止。
        signal: context.signal,
        // 生产入口开启运行存档（库级默认 false＝零写盘）：这是 resume 与事后审计的前提。
        persist: true,
      });
      const result =
        resumeArg !== undefined
          ? await runner.resume(resumeArg, def)
          : await runner.run(def as WorkflowDef);
      // `run()` 正常返回 ≠ 全部步骤成功：成败事实是 `result.ok`（含「上游依赖失败被跳过」的传递失败，
      // 但不含「条件未满足」的设计内跳过）。失败时把同一份渲染文本放进 `error`——
      // `ContextAssembler.toolContentOf` 对 ok=false 只渲染 error，放进 output 模型就看不到失败原因
      // （语义与同族 `subagentTool` 的失败分支对齐）。
      const rendered = this.render(result);
      return result.ok
        ? { callId: call.id, ok: true, output: rendered }
        : { callId: call.id, ok: false, error: rendered };
    } catch (error) {
      if (error instanceof WorkflowCycleError || error instanceof WorkflowSpecError) {
        return { callId: call.id, ok: false, error: error.message };
      }
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 判断实参是否是合法的「有步骤」的工作流定义形状。
   *
   * @param spec 工具实参里的 spec。
   * @returns 形状合法为 true。
   */
  private isWorkflowSpec(spec: unknown): boolean {
    return (
      spec !== undefined &&
      typeof spec === 'object' &&
      spec !== null &&
      Array.isArray((spec as Partial<WorkflowDef>).steps)
    );
  }

  /** 渲染工作流结果为带元信息的文本。
   * @param result 工作流运行结果（整体成败 + 各步骤明细 + runId）。
   * @returns 首行总体状态 + 运行 id/续跑提示 + 每步骤一行（按终态带标签）。
   */
  private render(result: WorkflowResult): string {
    const head = result.ok ? '工作流全部完成' : '工作流存在失败步骤';
    const resumedNote =
      result.resumed.length > 0
        ? `｜续跑复用 ${result.resumed.length} 步：${result.resumed.join('、')}`
        : '';
    const tailHint = result.ok
      ? ''
      : `\n\n可续跑：run_workflow({ resume: "${result.runId}" })（已完成的步骤复用产出，其余重跑）`;
    const lines = result.steps.map((step) => {
      // 同 `SubagentTool.render`（2026-10-01 审计对齐）：截断/熔断不是成功，必须显式标注，
      // 否则模型（与调用方）会把兜底摘要读成该步的真实结论。
      const status =
        step.truncated === true
          ? ' ⚠️ 未完成：达步数上限（结论可能不完整）'
          : step.aborted === true
            ? ' ⚠️ 未完成：被失控熔断/取消'
            : '';
      const label = WorkflowStepStatuses.labelOf(step.status);
      if (step.status === 'done') {
        return `[${step.id}] ${label}${status} ${step.output ?? ''}`;
      }
      return `[${step.id}] ${label}｜${step.error ?? '失败'}`;
    });
    return `${head}（runId: ${result.runId}${resumedNote}）\n${lines.join('\n')}${tailHint}`;
  }
}
