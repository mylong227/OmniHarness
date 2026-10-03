import type { EventPort } from '../ports/runtime/eventPort.js';
import type { ToolPort } from '../ports/tool/tool.js';

import { ConcurrencyLimiter } from '../util/concurrency/concurrencyLimiter.js';
import { FilteredToolPort } from '../core/filteredToolPort.js';
import { MUTATING_TOOLS } from '../core/toolGate.js';
import { Agent } from '../core/agent.js';
import { subagentRuntimeFactory } from '../subagent/subagentRuntimeFactory.js';
import { SubagentPorts } from '../subagent/subagentPorts.js';
import type { DelegateRequest, DelegateResult } from './a2aProtocol.js';
import type { TaskHandler } from './a2aServer.js';
import type { OmniHarnessRuntime } from '../ports/composition/omniHarnessRuntime.js';
import type { SubagentPortsShape } from '../ports/subagent/subagentPortsShape.js';

/** A2A 委托处理默认并发上限（对等方可能突发大量委托，需有界闸门避免资源耗尽）。 */
const DEFAULT_A2A_CONCURRENCY = 4;

/** 子代理运行时构造器（注入点，便于测试替换真实子代理工厂）。 */
export type SubagentBuilder = (
  ports: SubagentPortsShape,
  tools: ToolPort,
  events: EventPort,
  maxSteps: number,
) => OmniHarnessRuntime;

/** 任务执行器（注入点，便于测试替换真实 Agent 运行）。 */
export type A2aAgentRunner = (
  runtime: OmniHarnessRuntime,
  task: string,
) => Promise<{ readonly finalText?: string | undefined; readonly steps: number }>;

/** A2aTaskExecutor 选项。 */
export interface A2aTaskExecutorOptions {
  /** 并发上限（≥1；非法值回落到默认 4，不抛错避免直接阻断 serve 启动）。 */
  readonly maxConcurrency?: number | undefined;
  /** 子代理运行时构造器（缺省用全局 subagentRuntimeFactory）。 */
  readonly buildSubagent?: SubagentBuilder | undefined;
  /** 任务执行器（缺省用 `new Agent(runtime).runTask`）。 */
  readonly runTask?: A2aAgentRunner | undefined;
}

/**
 * A2A 任务委托执行器：把对等方委托的任务跑在一个**受限隔离**的子代理里。
 *
 * 两道纵深（对应审计 §30 跟进项 Gap ④）：
 * - **并发闸门**：所有入站委托共享进程内模型/存储/FFI 资源，无闸门会被突发委托拖垮整批；
 *   复用 {@link ConcurrencyLimiter}（信号量语义，槽位直接移交等待者）。
 * - **受限工具子集**：委托给对等方的工具面剔除 `MUTATING_TOOLS`（写类 / 危险工具），
 *   若委托请求本身声明了 `tools` 授权子集则进一步取交集——fail-closed，不把越权工具交给对等方。
 */
export class A2aTaskExecutor implements TaskHandler {
  /** 并发闸门（信号量语义，所有入站委托共享，避免突发委托拖垮进程内资源）。 */
  private readonly limiter: ConcurrencyLimiter;
  /** 子代理步数上限（取自父运行时 config.maxSteps）。 */
  private readonly maxSteps: number;
  /** 子代理运行时构造器（注入点，缺省走生产默认路径）。 */
  private readonly buildSubagent: SubagentBuilder;
  /** 任务执行器（注入点，缺省走 `new Agent(runtime).runTask`）。 */
  private readonly runTask: A2aAgentRunner;

  /**
   * 构造 A2A 任务委托执行器。
   * @param runtime 父运行时（取工具面 / 事件端口 / 步数上限）
   * @param options 并发上限与可注入的构造/执行回调（缺省走生产默认路径）
   */
  public constructor(
    private readonly runtime: OmniHarnessRuntime,
    options: A2aTaskExecutorOptions = {},
  ) {
    this.limiter = new ConcurrencyLimiter(
      Math.max(1, options.maxConcurrency ?? DEFAULT_A2A_CONCURRENCY),
    );
    this.maxSteps = runtime.config.maxSteps;
    this.buildSubagent = options.buildSubagent ?? A2aTaskExecutor.defaultBuildSubagent;
    this.runTask = options.runTask ?? A2aTaskExecutor.defaultRunTask;
  }

  /**
   * 执行一次委托任务（受并发闸门约束；异常也收敛为 ok:false 结果，不向对等方抛协议错误）。
   * @param request 委托请求（task 为自包含任务描述；tools 为可选授权子集）
   * @returns 委托结果（ok / output / steps / durationMs / error）
   */
  public async handle(request: DelegateRequest): Promise<DelegateResult> {
    const start = Date.now();
    return this.limiter.run(async () => {
      try {
        const sub = this.buildSubagent(
          SubagentPorts.portsOf(this.runtime),
          this.restrictedToolsOf(request),
          this.runtime.events,
          this.maxSteps,
        );
        const result = await this.runTask(sub, request.task);
        return {
          ok: true,
          output: result.finalText ?? '',
          steps: result.steps,
          durationMs: Date.now() - start,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { ok: false, output: '', steps: 0, durationMs: Date.now() - start, error: msg };
      }
    });
  }

  /**
   * 受限工具子集：剔除 `MUTATING_TOOLS`，并（若委托请求声明了授权子集）取交集。
   * @param request 委托请求
   * @returns 受限工具端口
   */
  private restrictedToolsOf(request: DelegateRequest): ToolPort {
    const authorized = request.tools;
    const allow = (name: string): boolean =>
      !MUTATING_TOOLS.has(name) && (authorized === undefined || authorized.includes(name));
    return new FilteredToolPort(this.runtime.tools, allow);
  }

  /** 默认子代理构造器（生产路径）。 */
  private static defaultBuildSubagent: SubagentBuilder = (ports, tools, events, maxSteps) =>
    subagentRuntimeFactory.build(ports, tools, events, maxSteps);

  /** 默认任务执行器（生产路径）。 */
  private static defaultRunTask: A2aAgentRunner = (rt, task) => new Agent(rt).runTask(task);
}
