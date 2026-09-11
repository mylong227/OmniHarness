import type { ToolPort } from '../ports/tool.js';
import type { AgentResult } from '../core/agent.js';
import { Agent } from '../core/agent.js';
import { SubagentEventBridge } from './subagentEventBridge.js';
import { subagentRuntimeFactory } from './subagentRuntimeFactory.js';
import { ToolSubset } from './toolSubset.js';
import { SUBAGENT_TOOL_NAME } from './subagentTypes.js';
import type { SubagentPorts } from './subagentPorts.js';
import type { SubagentRequest, SubagentResult } from './subagentTypes.js';

/**
 * @beta
 * 子智能体执行器：在受限 runtime 视图上跑一条独立的 Agent 循环。
 *
 * 复用主循环意味着子代自动继承上下文压缩、工具结果外溢、FFI 原生后端等全部既有能力，
 * 无需任何重复实现——本类只负责「隔离视图的装配」与「结果的度量」。
 */
export class SubagentRunner {
  public constructor(
    private readonly ports: SubagentPorts,
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
    );
    const outcome = await new Agent(runtime).runTask(request.task);
    return this.resultOf(request, outcome, bridge, startedAt);
  }

  /** 子代工具视图：白名单裁剪，并强制剔除 subagent 自身以杜绝进程内递归。 */
  private toolViewOf(request: SubagentRequest): ToolPort {
    const names = request.tools ?? this.ports.tools.list().map((definition) => definition.name);
    const allowed = new Set(names.filter((name) => name !== SUBAGENT_TOOL_NAME));
    return new ToolSubset(this.ports.tools, allowed);
  }

  /** 汇总执行结果（含耗时与完整轨迹）。 */
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
    };
  }
}
