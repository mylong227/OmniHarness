import { TOOL_NAMES } from '../ports/tool/toolNames.js';
import { WorkflowCycleError } from './workflowCycleError.js';
import { WorkflowGuard } from './workflowGuard.js';
import { WorkflowRunLog } from './workflowRunLog.js';
import { WorkflowSpecError } from './workflowSpecError.js';
import { WorkflowStepStatuses } from './workflowStepStatuses.js';

import { CANCELLED_BY_PARENT_MESSAGE } from '../subagent/subagentTypes.js';
import { Agent } from '../core/agent.js';
import { log } from '../util/logger.js';
import { WorkflowLayerPolicy } from './workflowLayerPolicy.js';
import { subagentRuntimeFactory } from '../subagent/subagentRuntimeFactory.js';
import { SubagentEventBridge } from '../subagent/subagentEventBridge.js';
import { ToolSubset } from '../subagent/toolSubset.js';
import { ConcurrencyLimiter } from '../util/concurrency/concurrencyLimiter.js';
import type {
  WorkflowDef,
  WorkflowResult,
  WorkflowStep,
  WorkflowStepResult,
} from './workflowTypes.js';
import type { WorkflowRunReplay } from './workflowRunLog.js';
import type { WorkflowStepStatus } from '../ports/autonomy/workflowStepStatus.js';
import { RUN_WORKFLOW_TOOL_NAME } from './workflowToolNames.js';

/**
 * @beta
 * 工作流默认同层并发上限。
 */
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;

/**
 * @beta
 * 工作流 DAG 中存在环。
 */

import type { GraphNodeStatus } from '../ports/autonomy/graphNodeStatus.js';
import type { SubagentPortsShape } from '../ports/subagent/subagentPortsShape.js';

export type { GraphNodeStatus } from '../ports/autonomy/graphNodeStatus.js';

/**
 * @beta
 * 节点状态变更事件。
 */
export interface GraphNodeUpdate {
  /** 步骤 ID。 */
  readonly id: string;
  /** 新状态。 */
  readonly status: GraphNodeStatus;
  /** 失败/跳过原因。 */
  readonly error?: string;
  /** 子智能体步数（done 时有效）。 */
  readonly steps?: number;
  /** 耗时（毫秒）。 */
  readonly durationMs?: number;
}

/**
 * @beta
 * WorkflowRunner 选项。
 */
export interface WorkflowRunnerOptions {
  /** 同层最大并发步数（须为 ≥1 的整数；非法即抛 {@link WorkflowSpecError}）。 */
  readonly maxConcurrency?: number | undefined;
  /** 节点状态变更回调（可选，供实时进度推送）。 */
  readonly onNodeUpdate?: ((update: GraphNodeUpdate) => void) | undefined;
  /**
   * 父会话取消信号（可选）：置位后不再启动新步骤，并把在飞步骤的模型请求一并中止
   * （子代 runtime 的模型端口按此信号协作式取消）。缺省 undefined＝不传播取消。
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * 是否把运行状态落盘（默认 **false**＝库级零行为）。
   *
   * 口径与 `selfVerify` / `decisionEngine` 一致：**库级默认不产生副作用**（单测/嵌入方零写盘），
   * **生产入口**（`run_workflow` 工具）显式开启。开启后每次运行写
   * `<workspace>/.omniharness/graph-runs/<runId>.jsonl`，并因此获得 `resume()` 能力。
   */
  readonly persist?: boolean | undefined;
  /** 本次运行的 id（缺省自动生成；显式给出时须符合 `[A-Za-z0-9_-]{1,80}`）。 */
  readonly runId?: string | undefined;
}

/** 调度上下文（本次运行的持久化与尝试计数，供各步骤记录用）。 */
interface RunContext {
  /** 运行 id。 */
  readonly runId: string;
  /** 运行日志（未开启持久化时为 undefined）。 */
  readonly log: WorkflowRunLog | undefined;
  /** 各步骤在本轮开始前的尝试次数（续跑时来自日志）。 */
  readonly attemptBase: ReadonlyMap<string, number>;
}

/** 一层内「本层不执行但需记账」的判定结果。 */
interface LevelVerdict {
  /** 本层可执行的步骤 id（保序）。 */
  readonly runnable: readonly string[];
  /** 本层直接判终态的步骤（blocked / skipped），需按序记账。 */
  readonly settled: readonly {
    readonly id: string;
    readonly status: WorkflowStepStatus;
    readonly error: string;
  }[];
}

/**
 * @beta
 * 工作流 DAG 编排器（对标 dsh agent-team / workflow DAG）：
 * 把多步任务组织为有向无环图，按拓扑层级调度——同层并发（受 {@link DEFAULT_WORKFLOW_CONCURRENCY} 闸门约束），
 * 前序步骤产出经 blackboard 注入后续步骤 prompt；某步失败则其全部下游 fail-closed 跳过（绝不静默续跑）。
 *
 * ## 两条 2026-10-08 增补的能力（按价值筛选后落地，见看板 §8.8）
 *
 * 1. **受控条件执行**（`step.when`）：静态 DAG 之上的分支表达力——「仅当某已依赖步骤处于某终态时才执行」，
 *    **不改拓扑**、不引入环。条件不满足记为 `skipped`（设计内跳过，**不阻断下游**），
 *    与「被上游失败拖死」的 `blocked` 严格区分（后者 fail-closed 传播）。
 * 2. **运行状态持久化 + 断点续跑**（`options.persist` + {@link resume}）：追加式 JSONL 运行日志
 *    （不用 LangGraph 式全量快照，沿用本仓「追加日志 + 游标」哲学）；`resume` 只复用 `done` 步骤的产出，
 *    其余（失败 / 中断 / 跳过）按原顺序重跑并留下 attempt 级留痕。
 *
 * 复用 {@link Agent} 主循环意味着每步自动继承上下文压缩、工具结果外溢、FFI 原生后端等全部既有能力，
 * 本类只负责「DAG 调度 + 条件裁决 + 依赖注入 + 失败传播 + 运行存档」。
 */
export class WorkflowRunner {
  private readonly maxConcurrency: number;

  public constructor(
    private readonly ports: SubagentPortsShape,
    private readonly options: WorkflowRunnerOptions = {},
  ) {
    // 非法并发上限 fail-closed：非法值会让闸门永不放行（调用方永久挂起），
    // 故在构造期就拒绝并给出可执行信息，而不是留给 run() 挂死。
    this.maxConcurrency = WorkflowSpecError.requireWorkflowConcurrency(
      options.maxConcurrency,
      DEFAULT_WORKFLOW_CONCURRENCY,
    );
  }

  /**
   * 运行工作流 DAG 直到达成或遇环 / 规格非法 / 失败传播 / 父会话取消。
   *
   * @param def 工作流定义（步骤 DAG + 可选并发上限）。
   * @returns 各步骤结果与整体状态（含 runId；`persist` 开启时可用它 {@link resume}）。
   */
  public async run(def: WorkflowDef): Promise<WorkflowResult> {
    WorkflowGuard.validate(def.steps);
    const maxConcurrency = WorkflowSpecError.requireWorkflowConcurrency(
      def.maxConcurrency,
      this.maxConcurrency,
    );
    const log =
      this.options.persist === true ? new WorkflowRunLog(this.ports.workspaceRoot) : undefined;
    const runId = this.options.runId ?? WorkflowRunLog.newRunId(def.name);
    log?.create(def, runId, maxConcurrency);
    return this.schedule(def, runId, maxConcurrency, log, undefined);
  }

  /**
   * **断点续跑**：从既有运行日志继续未完成的工作流。
   *
   * 语义（商业级口径：可预测 + 可审计）：
   * - `done` 步骤**复用产出**（不重跑，省 token），并写入 `resumed` 列表；
   * - `failed` / `blocked` / `cancelled` / `skipped` / 中断（有 start 无 end）的步骤**重新执行**，
   *   每次尝试都在日志里留下独立的 `step.start`/`step.end` 对（重试事实可审计）；
   * - 规格从日志首行读回（调用方不必记住定义）；若同时传入 `expectedSpec`，则校验哈希一致，
   *   不一致即**拒绝续跑**——避免把两份不同定义的产出拼在一起。
   *
   * 诚实边界：重跑会**再次产生副作用**（写文件、跑命令）。有副作用的步骤请自行声明 `writes`，
   * 并由调用方判断「重跑是否安全」——本类不做幂等性推断（无法从工具契约推出）。
   *
   * @param runId 运行 id（来自上次 {@link run} 的返回值）。
   * @param expectedSpec 可选：调用方手上的规格（用于一致性校验）。
   * @returns 各步骤结果与整体状态。
   * @throws WorkflowSpecError 日志缺失/损坏/哈希不一致/规格非法时抛出。
   */
  public async resume(runId: string, expectedSpec?: WorkflowDef): Promise<WorkflowResult> {
    const log = new WorkflowRunLog(this.ports.workspaceRoot);
    const replay = log.read(runId);
    const def = replay.header.spec;
    WorkflowGuard.validate(def.steps);
    if (
      expectedSpec !== undefined &&
      WorkflowRunLog.hashSpec(expectedSpec) !== replay.header.specHash
    ) {
      throw new WorkflowSpecError(
        `runId「${runId}」记录的规格与本次传入的 spec 不一致：拒绝续跑（避免把两次不同定义的产出拼在一起）`,
      );
    }
    return this.schedule(def, runId, replay.header.maxConcurrency, log, replay);
  }

  /**
   * 调度主循环：逐层「判定 → 执行 → 记账」，并在每步前后写运行日志。
   *
   * @param def 工作流定义。
   * @param runId 运行 id。
   * @param maxConcurrency 生效的并发上限。
   * @param log 运行日志（未持久化时为 undefined）。
   * @param replay 续跑时的回放状态（新跑为 undefined）。
   * @returns 工作流整体结果。
   */
  private async schedule(
    def: WorkflowDef,
    runId: string,
    maxConcurrency: number,
    log: WorkflowRunLog | undefined,
    replay: WorkflowRunReplay | undefined,
  ): Promise<WorkflowResult> {
    // 构造期已用空步骤列表校验过（见构造函数），此处必须再校验一次真实步骤：
    // 构造期的占位校验不能替代「本次这份定义」的引用完整性检查。
    WorkflowGuard.validate(def.steps);
    const byId = new Map(def.steps.map((step) => [step.id, step]));
    const levels = WorkflowRunner.computeLevels(def.steps);
    const context: RunContext = {
      runId,
      log,
      attemptBase: replay?.attempts ?? new Map<string, number>(),
    };
    const statuses = new Map<string, WorkflowStepStatus>();
    const blackboard: Record<string, string> = {};
    const results: WorkflowStepResult[] = [];
    const resumed: string[] = [];
    this.replayDone(replay, statuses, blackboard, results, resumed);

    for (const level of levels) {
      if (this.isCancelled()) {
        this.recordSettled(
          level.map((id) => ({
            id,
            status: 'cancelled' as const,
            error: CANCELLED_BY_PARENT_MESSAGE,
          })),
          statuses,
          results,
          context,
        );
        continue;
      }
      const verdict = this.classify(level, byId, statuses, blackboard);
      this.recordSettled(verdict.settled, statuses, results, context);
      if (verdict.runnable.length === 0) {
        continue;
      }
      const limiter = new ConcurrencyLimiter(maxConcurrency);
      const outs = await this.runLayer(verdict.runnable, byId, blackboard, limiter, context);
      for (const out of outs) {
        this.recordExecuted(out, statuses, blackboard, results, context);
      }
    }

    const ok = results.every((entry) => WorkflowStepStatuses.countsAsSuccess(entry.status));
    log?.appendRunEnd(runId, ok);
    return { ok, steps: results, blackboard, runId, resumed };
  }

  /**
   * 把续跑前已 `done` 的步骤投影进本次运行（产出复用，不重跑）。
   *
   * @param replay 回放状态（新跑为 undefined）。
   * @param statuses 终态表（就地写入）。
   * @param blackboard 产出黑板（就地写入）。
   * @param results 结果数组（就地追加）。
   * @param resumed 复用的步骤 id 列表（就地追加）。
   * @returns 无返回值。
   */
  private replayDone(
    replay: WorkflowRunReplay | undefined,
    statuses: Map<string, WorkflowStepStatus>,
    blackboard: Record<string, string>,
    results: WorkflowStepResult[],
    resumed: string[],
  ): void {
    if (replay === undefined) {
      return;
    }
    for (const [id, status] of replay.statuses) {
      if (status !== 'done') {
        continue; // 非 done 一律重跑：续跑只复用「真的完成了」的产出。
      }
      const output = replay.outputs.get(id);
      statuses.set(id, 'done');
      resumed.push(id);
      if (output !== undefined) {
        blackboard[id] = output;
      }
      results.push({
        id,
        ok: true,
        status: 'done',
        ...(output !== undefined ? { output } : {}),
        steps: 0,
        durationMs: 0,
      });
      this.options.onNodeUpdate?.({ id, status: 'done', steps: 0, durationMs: 0 });
    }
  }

  /**
   * 判定一层里哪些步骤可执行、哪些直接判终态（顺序：**先条件裁决，再失败传播**）。
   *
   * 为什么条件裁决必须在前（2026-10-08 语义要点）：本能力的典型用法就是
   * `{ when: { step:'test', status:'failed' } }`（失败才补救）——若先做失败传播，
   * 这个「补救步」会在条件被裁决之前就被上游失败拖成 blocked，功能直接失效。
   *
   * @param level 本层步骤 id（拓扑层内保序）。
   * @param byId 步骤索引。
   * @param statuses 已记录终态。
   * @param blackboard 已记录产出（`outputMatches` 用）。
   * @returns 可执行集合 + 直接判终态集合。
   */
  private classify(
    level: readonly string[],
    byId: ReadonlyMap<string, WorkflowStep>,
    statuses: ReadonlyMap<string, WorkflowStepStatus>,
    blackboard: Readonly<Record<string, string>>,
  ): LevelVerdict {
    const runnable: string[] = [];
    const settled: { id: string; status: WorkflowStepStatus; error: string }[] = [];
    for (const id of level) {
      if (statuses.has(id)) {
        continue; // 已在续跑中复用或本层前序判定过。
      }
      const step = byId.get(id)!;
      const deps = step.dependsOn ?? [];
      const blockedBy = deps.filter((dep) => {
        const depStatus = statuses.get(dep);
        return depStatus !== undefined && WorkflowStepStatuses.blocksDownstream(depStatus);
      });
      const guard = step.when;
      if (guard !== undefined) {
        const verdict = WorkflowGuard.decide(guard, statuses, blackboard);
        if (!verdict.run) {
          settled.push({ id, status: 'skipped', error: verdict.reason });
          continue;
        }
        // 条件成立：被观察步骤的状态不再是阻塞理由（其余依赖仍按 fail-closed 判定）。
        const otherBlockers = blockedBy.filter((dep) => dep !== guard.step);
        if (otherBlockers.length > 0) {
          settled.push({ id, status: 'blocked', error: this.blockedReason(otherBlockers) });
          continue;
        }
        runnable.push(id);
        continue;
      }
      if (blockedBy.length > 0) {
        settled.push({ id, status: 'blocked', error: this.blockedReason(blockedBy) });
        continue;
      }
      runnable.push(id);
    }
    return { runnable, settled };
  }

  /**
   * 构造「被上游拖死」的可读原因（与条件跳过的措辞区分开，避免事后误读）。
   *
   * @param blockedBy 处于阻塞终态的依赖 id 列表。
   * @returns 原因文本。
   */
  private blockedReason(blockedBy: readonly string[]): string {
    return `上游依赖失败/未完成（${blockedBy.join('、')}），已跳过`;
  }

  /**
   * 记账「本轮未执行」的步骤（blocked / skipped / cancelled）：写终态、写日志、发节点事件。
   *
   * @param records 待记账项（保序）。
   * @param statuses 终态表（就地写入）。
   * @param results 结果数组（就地追加）。
   * @param context 调度上下文。
   * @returns 无返回值。
   */
  private recordSettled(
    records: readonly {
      readonly id: string;
      readonly status: WorkflowStepStatus;
      readonly error: string;
    }[],
    statuses: Map<string, WorkflowStepStatus>,
    results: WorkflowStepResult[],
    context: RunContext,
  ): void {
    for (const record of records) {
      if (statuses.has(record.id)) {
        continue;
      }
      statuses.set(record.id, record.status);
      results.push({
        id: record.id,
        ok: record.status === 'done',
        status: record.status,
        error: record.error,
        steps: 0,
        durationMs: 0,
      });
      this.options.onNodeUpdate?.({
        id: record.id,
        status: record.status === 'skipped' ? 'skipped' : 'failed',
        error: record.error,
        durationMs: 0,
      });
      context.log?.appendStepEnd(context.runId, {
        id: record.id,
        status: record.status,
        attempt: (context.attemptBase.get(record.id) ?? 0) + 1,
        error: record.error,
        steps: 0,
        durationMs: 0,
      });
    }
  }

  /**
   * 记账「本轮执行完成」的步骤：写终态、按需把产出注入黑板、写日志。
   *
   * @param out 该步执行结果。
   * @param statuses 终态表（就地写入）。
   * @param blackboard 产出黑板（就地写入）。
   * @param results 结果数组（就地追加）。
   * @param context 调度上下文。
   * @returns 无返回值。
   */
  private recordExecuted(
    out: WorkflowStepResult,
    statuses: Map<string, WorkflowStepStatus>,
    blackboard: Record<string, string>,
    results: WorkflowStepResult[],
    context: RunContext,
  ): void {
    statuses.set(out.id, out.status);
    results.push(out);
    // 失败才阻塞下游；**成功但无产出**（finalText 为 undefined）只是「没有内容可注入下游」，
    // 若把它并入失败集合，下游会被 fail-closed 跳过、整体 ok 变 false——等于把
    // 「这一步没吐文本」误判成「这一步失败了」，并把假故障一路传染给全部下游。
    if (out.status === 'done' && out.output !== undefined) {
      // 未完成标注（2026-10-01 审计）：截断/熔断步骤的产出是兜底摘要，若原样注入下游
      // prompt，「跑满步数」会被下游读成「前序已确认的事实」一路传染。
      blackboard[out.id] = this.incompletenessPrefixOf(out) + out.output;
    }
    context.log?.appendStepEnd(context.runId, {
      id: out.id,
      status: out.status,
      attempt: (context.attemptBase.get(out.id) ?? 0) + 1,
      ...(out.output !== undefined ? { output: out.output } : {}),
      ...(out.error !== undefined ? { error: out.error } : {}),
      steps: out.steps,
      durationMs: out.durationMs,
      ...(out.truncated === true ? { truncated: true } : {}),
      ...(out.aborted === true ? { aborted: true } : {}),
    });
  }

  /** 未完成产出注入下游时的前缀标注（截断 / 熔断步骤的产出不可读作已确认事实）。
   * @param out 该步执行结果。
   * @returns 需要标注时返回带换行的前缀文本，已完成时返回空串。
   */
  private incompletenessPrefixOf(out: WorkflowStepResult): string {
    if (out.truncated === true) {
      return '⚠️【前序步骤未完成：达步数上限，以下为兜底摘要，可能不完整】\n';
    }
    if (out.aborted === true) {
      return '⚠️【前序步骤未完成：被失控熔断/取消，以下为中断时的摘要】\n';
    }
    return '';
  }

  /**
   * 父会话是否已取消（未注入取消信号时恒为 false）。
   * @returns 已取消为 true
   */
  private isCancelled(): boolean {
    return this.options.signal?.aborted === true;
  }

  /**
   * 执行一层（同层步骤互不依赖）。**默认并发**，但有一条例外（2026-10-03 第六轮修看板 §8.1）：
   *
   * 工作流步骤**共享父工作区**（本类不建隔离工作树——步骤产出要落在同一工作区供后续步骤使用，
   * 这也是与 `SubagentOrchestrator` 的 worktree 隔离**语义相反**的原因）。于是同层里若有**多个**
   * 步骤都可能写文件（工具视图含写类工具，或未声明 `tools` 即拿到全集），并发执行会互相覆盖同一个文件，
   * 且没有任何冲突检测。这种层一律**退化为串行**：宁可慢一点，也不要产出"结果不可复现"的覆盖竞争。
   * @param runnable 本层待执行步骤 id（已剔除被跳过的）。
   * @param byId 步骤索引。
   * @param blackboard 前序产出黑板（就地写入）。
   * @param limiter 并发闸门（串行档下每次仍经它计量）。
   * @param context 调度上下文（运行日志 + 尝试计数）。
   * @returns 本层各步骤结果（顺序与 `runnable` 一致）。
   */
  private async runLayer(
    runnable: readonly string[],
    byId: ReadonlyMap<string, WorkflowStep>,
    blackboard: Record<string, string>,
    limiter: ConcurrencyLimiter,
    context: RunContext,
  ): Promise<readonly WorkflowStepResult[]> {
    const steps = runnable
      .map((id) => byId.get(id)!)
      .filter((s): s is WorkflowStep => s !== undefined);
    const parallel = !WorkflowLayerPolicy.shouldSerialize(steps);
    if (!parallel) {
      if (runnable.length > 1) {
        log.warn('workflow.layer.serialized', {
          steps: [...runnable],
          hint: '同层存在多个可能写文件的步骤且工作区共享 ⇒ 退化为串行，避免并发覆盖同一文件',
        });
      }
      const serial: WorkflowStepResult[] = [];
      for (const id of runnable) {
        serial.push(await limiter.run(() => this.execute(byId.get(id)!, blackboard, context)));
      }
      return serial;
    }
    return Promise.all(
      runnable.map((id) => limiter.run(() => this.execute(byId.get(id)!, blackboard, context))),
    );
  }

  /**
   * 执行单步：构造**共享工作区**的子智能体，注入前序产出，跑一次回合。
   * @param step 待执行步骤
   * @param blackboard 前序步骤的黑板产出（按步骤 id 索引）
   * @param context 调度上下文（运行日志 + 尝试计数）
   * @returns 单步结果（输出/终态/耗时）
   */
  private async execute(
    step: WorkflowStep,
    blackboard: Record<string, string>,
    context: RunContext,
  ): Promise<WorkflowStepResult> {
    const startedAt = Date.now();
    this.options.onNodeUpdate?.({ id: step.id, status: 'running' });
    context.log?.appendStepStart(
      context.runId,
      step.id,
      (context.attemptBase.get(step.id) ?? 0) + 1,
    );
    try {
      const bridge = new SubagentEventBridge();
      const runtime = subagentRuntimeFactory.build(
        this.ports,
        this.toolViewOf(step),
        bridge,
        this.ports.maxSteps,
        // 取消传播：父会话取消 → 本步子代的在飞模型请求一并中止。
        this.options.signal,
      );
      const outcome = await new Agent(runtime).runTask(this.promptFor(step, blackboard));
      const durationMs = Date.now() - startedAt;
      this.options.onNodeUpdate?.({
        id: step.id,
        status: 'done',
        steps: outcome.steps,
        durationMs,
      });
      return {
        id: step.id,
        ok: true,
        status: 'done',
        output: outcome.finalText,
        steps: outcome.steps,
        durationMs,
        // 「步数耗尽」不等于「任务完成」：如实透传，供渲染层与下游注入处标注。
        truncated: outcome.truncated === true ? true : undefined,
        aborted: outcome.aborted === true ? true : undefined,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.options.onNodeUpdate?.({ id: step.id, status: 'failed', error: message, durationMs });
      return {
        id: step.id,
        ok: false,
        status: 'failed',
        error: message,
        steps: 0,
        durationMs,
      };
    }
  }

  /**
   * 构造带前序产出的提示词。
   * @param step 当前步骤
   * @param blackboard 前序产出（仅取 dependsOn 引用的条目）
   * @returns 注入依赖产出后的提示词
   */
  private promptFor(step: WorkflowStep, blackboard: Record<string, string>): string {
    const deps = step.dependsOn ?? [];
    if (deps.length === 0) {
      return step.prompt;
    }
    const context = deps.map((dep) => `[${dep}]\n${blackboard[dep] ?? '（无产出）'}`).join('\n\n');
    return `${step.prompt}\n\n已有上下文（前序步骤产出）：\n${context}`;
  }

  /**
   * 把工作流步骤投给模型可读的工具视图（隐藏实现细节，仅暴露名称/意图）。
   * @param step 工作流步骤
   * @returns 单行摘要文本
   */
  private toolViewOf(step: WorkflowStep): ToolSubset {
    const names = step.tools ?? this.ports.tools.list().map((definition) => definition.name);
    const allowed = new Set(
      names.filter(
        (name) =>
          name !== RUN_WORKFLOW_TOOL_NAME &&
          name !== TOOL_NAMES.runGoal &&
          name !== TOOL_NAMES.subagent,
      ),
    );
    return new ToolSubset(this.ports.tools, allowed);
  }

  /**
   * @beta
   * 拓扑分层（Kahn 算法）：返回按依赖顺序排列的层级（同层步骤互不依赖，可并发）。
   * 存在环时抛 {@link WorkflowCycleError}（fail-closed，不偷偷按错误顺序跑）。
   */
  public static computeLevels(steps: readonly WorkflowStep[]): readonly (readonly string[])[] {
    const byId = new Map(steps.map((step) => [step.id, step]));
    if (new Set(steps.map((step) => step.id)).size !== steps.length) {
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const step of steps) {
        if (seen.has(step.id)) dupes.add(step.id);
        seen.add(step.id);
      }
      throw new WorkflowCycleError(`步骤 id 重复：${[...dupes].join('、')}`);
    }
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const step of steps) {
      indegree.set(step.id, step.dependsOn?.length ?? 0);
      for (const dep of step.dependsOn ?? []) {
        if (!byId.has(dep)) {
          throw new WorkflowCycleError(
            `步骤「${step.id}」依赖不存在的步骤「${dep}」（可用步骤：${[...byId.keys()].join('、')}）`,
          );
        }
        dependents.set(dep, [...(dependents.get(dep) ?? []), step.id]);
      }
    }
    const levels: string[][] = [];
    let current = steps
      .filter((step) => (step.dependsOn?.length ?? 0) === 0)
      .map((step) => step.id);
    // 种子层（无依赖的起点）同样计入已访问，否则会漏算导致误判成环。
    const visited = new Set<string>(current);
    while (current.length > 0) {
      levels.push(current);
      const next: string[] = [];
      for (const id of current) {
        for (const dependent of dependents.get(id) ?? []) {
          const remaining = (indegree.get(dependent) ?? 0) - 1;
          indegree.set(dependent, remaining);
          if (remaining === 0 && !visited.has(dependent)) {
            visited.add(dependent);
            next.push(dependent);
          }
        }
      }
      current = next;
    }
    if (visited.size !== steps.length) {
      const stuck = steps.filter((step) => !visited.has(step.id)).map((step) => step.id);
      throw new WorkflowCycleError(
        `依赖成环，无法排序的步骤：${stuck.join('、')}（请检查这些步骤之间的 dependsOn）`,
      );
    }
    return levels;
  }
}

export { WorkflowCycleError };
export { WorkflowSpecError };
