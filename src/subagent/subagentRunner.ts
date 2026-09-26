import type { ToolPort } from '../ports/tool/tool.js';
import type { AgentResult } from '../core/agent.js';
import { Agent } from '../core/agent.js';
import { SubagentEventBridge } from './subagentEventBridge.js';
import { subagentRuntimeFactory } from './subagentRuntimeFactory.js';
import { ToolSubset } from './toolSubset.js';
import { SUBAGENT_TOOL_NAME } from './subagentTypes.js';
import type { SubagentPortsShape } from './subagentPorts.js';
import type { SubagentRequest, SubagentResult } from './subagentTypes.js';

/**
 * @beta
 * 子智能体执行器：在受限 runtime 视图上跑一条独立的 Agent 循环。
 *
 * 复用主循环意味着子代自动继承上下文压缩、工具结果外溢、FFI 原生后端等全部既有能力，
 * 无需任何重复实现——本类只负责「隔离视图的装配」与「结果的度量」。
 */
export class SubagentRunner {
  /**
   * 从子代工具视图中**强制剔除**的递归入口。
   *
   * `subagent` 是进程内直接递归；`run_workflow` / `run_goal` 各自会起真 Agent 回合，
   * 是同一递归的间接形态（见 {@link SubagentRunner.toolViewOf} 的注释）。
   */
  private static readonly RECURSION_TOOLS: ReadonlySet<string> = new Set([
    SUBAGENT_TOOL_NAME,
    'run_workflow',
    'run_goal',
  ]);

  public constructor(
    private readonly ports: SubagentPortsShape,
    private readonly maxSteps: number,
  ) {}

  /** 执行子任务（步数超限等致命错误向外抛，由编排层统一转失败结果）。 */
  public async run(request: SubagentRequest): Promise<SubagentResult> {
    const startedAt = Date.now();
    const bridge = new SubagentEventBridge();
    const runtime = subagentRuntimeFactory.build(
      this.ports,
      this.toolViewOf(request),
      bridge,
      this.maxSteps,
      // 取消传播：父会话取消 → 子代在飞模型请求中止（见 cancellableModel）。
      request.signal,
    );
    const outcome = await new Agent(runtime).runTask(request.task);
    return this.resultOf(request, outcome, bridge, startedAt);
  }

  /** 子代工具视图：白名单裁剪，并强制剔除全部**再派生入口**以杜绝递归。
   *
   * 为什么要剔除三个而不是一个（2026-09-26 审计 F4）：原先只剔 `subagent`，但子代仍持有
   * `run_workflow` / `run_goal` —— 二者各自会起真 Agent 回合，于是
   * `主会话 → subagent → run_goal → agent → run_workflow → 子步` 可以走到 4 层 Agent，
   * 与「maxDepth=2」的声明不符（深度上限在生产路径上形同虚设）。
   */
  private toolViewOf(request: SubagentRequest): ToolPort {
    const names = request.tools ?? this.ports.tools.list().map((definition) => definition.name);
    const allowed = new Set(names.filter((name) => !SubagentRunner.RECURSION_TOOLS.has(name)));
    return new ToolSubset(this.ports.tools, allowed);
  }

  /** 汇总执行结果（含耗时与完整轨迹，**并如实带上「是否做完」**）。 */
  private resultOf(
    request: SubagentRequest,
    outcome: AgentResult,
    bridge: SubagentEventBridge,
    startedAt: number,
  ): SubagentResult {
    return {
      ok: true,
      sessionId: outcome.sessionId,
      output: outcome.finalText ?? '',
      steps: outcome.steps,
      durationMs: Date.now() - startedAt,
      depth: request.depth,
      events: outcome.events.length > 0 ? outcome.events : bridge.events(),
      truncated: outcome.truncated === true,
      aborted: outcome.aborted === true,
    };
  }
}
