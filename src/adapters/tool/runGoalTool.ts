import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { SubagentPorts } from '../../subagent/subagentPorts.js';
import { Agent } from '../../core/agent.js';
import { SubagentRuntimeFactory } from '../../subagent/subagentRuntimeFactory.js';
import { SubagentEventBridge } from '../../subagent/subagentEventBridge.js';
import { ToolSubset } from '../../subagent/toolSubset.js';
import { GoalRunner, type GoalRunnerOptions } from '../../autonomy/goalRunner.js';
import { GoalChecker } from '../../autonomy/goalChecker.js';
import { RUN_GOAL_TOOL_NAME } from '../../autonomy/goalToolNames.js';

/** 模型面 run_goal 工具：派生一个进程内自主目标循环完成子目标。 */
export class RunGoalTool {
  /** 工具定义。 */
  readonly definition: ToolDefinition = {
    name: RUN_GOAL_TOOL_NAME,
    description:
      '派生一个进程内自主目标循环完成子目标：独立会话、受限工具集、不可再派生 run_goal/subagent。适合目标明确、需多轮自主推进才能完成的子任务。',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '子目标描述。需自包含——目标循环看不到主会话历史。',
        },
        tools: {
          type: 'array',
          description:
            '可选：授权给目标循环的工具名列表；不传则继承除 run_goal/subagent 外的全部工具。',
        },
        maxIterations: {
          type: 'number',
          description: '可选：最大迭代次数（默认 10）。',
        },
      },
      required: ['goal'],
    },
  };

  constructor(
    private readonly ports: SubagentPorts,
    private readonly options: GoalRunnerOptions = {},
  ) {}

  /** 派生并运行自主目标循环。 */
  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const goal = String(call.arguments['goal'] ?? '').trim();
    if (goal === '') {
      return { callId: call.id, ok: false, error: '缺少子目标描述: goal' };
    }
    const bridge = new SubagentEventBridge();
    const runtime = SubagentRuntimeFactory.build(
      this.ports,
      this.toolViewOf(call),
      bridge,
      this.ports.maxSteps,
    );
    const agent = new Agent(runtime);
    const runner = new GoalRunner(agent, new GoalChecker(this.ports.model), {
      ...this.options,
      maxIterations: this.maxIterationsOf(call),
    });
    const result = await runner.run(goal);
    return { callId: call.id, ok: true, output: this.render(result) };
  }

  /** 渲染结果为带元信息的文本（子会话 ID 可回溯完整轨迹）。 */
  private render(result: {
    readonly achieved: boolean;
    readonly iterations: number;
    readonly sessionId: string;
    readonly finalText?: string;
  }): string {
    const verdict = result.achieved ? '已达成' : '未达成';
    const head = `[目标循环 ${result.sessionId}] ${verdict}｜${result.iterations} 轮`;
    return `${head}\n${result.finalText ?? ''}`;
  }

  /** 提取可选的工具白名单。 */
  private toolViewOf(call: ToolCall) {
    const raw = call.arguments['tools'];
    const names = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    const allowed = new Set(
      (names ?? this.ports.tools.list().map((definition) => definition.name)).filter(
        (name) => name !== RUN_GOAL_TOOL_NAME && name !== 'subagent',
      ),
    );
    return new ToolSubset(this.ports.tools, allowed);
  }

  /** 提取可选的最大迭代次数（工具参数优先于构造期默认值）。 */
  private maxIterationsOf(call: ToolCall): number | undefined {
    const raw = call.arguments['maxIterations'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.floor(raw);
    }
    return this.options.maxIterations;
  }
}
