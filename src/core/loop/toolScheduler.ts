/**
 * ToolScheduler（Agent Loop V2 工具并行调度，对标 codex tools/parallel.rs 的
 * 工具级门控 + deepseek-harness tool-calls.ts 的有界池与互斥屏障，零依赖）。
 *
 * 语义：
 *  - 并行能力是**工具级静态声明**（parallelCapable），不做调用间数据依赖分析
 *    （codex/dsh 同样不做——静态声明已覆盖绝大多数安全并行场景）。
 *  - 连续的并行安全调用组成并行批（有界池 maxParallel，默认 8）；
 *    遇到非并行安全调用（写类/副作用类）形成屏障：先排空当前并行批，再串行执行。
 *    这保证「读读并行、写前全静、写后串行」的保守安全序。
 *  - 结果严格按 model-order 提交（与请求顺序一致），上层无需重排。
 *  - 单个工具抛异常被捕获并转为 failed ToolResult，绝不连累同批其他工具
 *    （与 StepRunner 既有行为对齐）。
 */

import type { ToolCall, ToolResult } from '../../ports/tool/tool.js';
import { ArrayAt } from '../../util/arrayAt.js';
import { MUTATING_TOOLS } from '../toolGate.js';

/** 工具调用执行器（StepRunner.runToolCall 的抽象，保持签名稳定）。 */
export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>;

/** 单个工具的调度结果（保持与输入同序）。 */
export interface ScheduledResult {
  readonly call: ToolCall;
  readonly result: ToolResult;
}

export interface ToolSchedulerOptions {
  /** 并行批最大并发，默认 8。 */
  readonly maxParallel?: number;
  /**
   * 工具是否可并行（并行安全 = 只读或无共享可变状态）。
   * 缺省用保守内置策略：write/apply/mutate 前缀视为串行，其余并行。
   */
  readonly parallelCapable?: (toolName: string) => boolean;
}

/** 保守内置判定：名字含写类动词/写类工具名单则必须串行（调度器缺省 parallelCapable）。 */
const SERIAL_PATTERNS = [
  'write',
  'apply',
  'edit',
  'delete',
  'remove',
  'mkdir',
  'move',
  'rename',
  'commit',
  'install',
  'bash',
  'shell',
  'exec',
  'run_',
  'subagent',
  'delegate',
  'goal',
  'workflow',
];

export class ToolScheduler {
  /** 并行批最大并发（下限 1，默认 8）。 */
  private readonly maxParallel: number;
  /** 工具并行安全判定（缺省用 SERIAL_PATTERNS 保守内置策略）。 */
  private readonly parallelCapable: (toolName: string) => boolean;

  public constructor(options: ToolSchedulerOptions = {}) {
    this.maxParallel = Math.max(1, options.maxParallel ?? 8);
    this.parallelCapable = options.parallelCapable ?? ToolScheduler.defaultParallelCapable;
  }

  /**
   * 调度执行一批工具调用：连续并行安全调用并行化（有界池），写类形成屏障串行。
   * 返回结果与输入同序（model-order），上层按序记录即可。
   * @param calls 模型本步发出的全部工具调用。
   * @param execute 单调用执行器（StepRunner.runToolCall 抽象）。
   * @returns 与输入同序的调度结果数组（失败已转为 failed ToolResult）。
   */
  public async run(
    calls: readonly ToolCall[],
    execute: ToolExecutor,
  ): Promise<readonly ScheduledResult[]> {
    const results = new Array<ScheduledResult | undefined>(calls.length);
    let i = 0;
    while (i < calls.length) {
      if (this.parallelCapable(ArrayAt.at(calls, i).name)) {
        // 收集连续的并行安全调用为一批（有界：批内再按 maxParallel 滚动并发）。
        let j = i;
        while (j < calls.length && this.parallelCapable(ArrayAt.at(calls, j).name)) {
          j += 1;
        }
        await this.runParallelBatch(calls, i, j, execute, results);
        i = j;
      } else {
        // 屏障：此刻必然没有在飞任务（并行批已在上方 await 排空），直接串行执行。
        results[i] = {
          call: ArrayAt.at(calls, i),
          result: await ToolScheduler.safeExecute(ArrayAt.at(calls, i), execute),
        };
        i += 1;
      }
    }
    return results.map(
      (r, idx) =>
        r ?? {
          call: ArrayAt.at(calls, idx),
          result: ToolScheduler.failedResult(ArrayAt.at(calls, idx), new Error('调度遗漏')),
        },
    );
  }

  /**
   * 有界并发执行 [from, to) 区间的并行安全调用；Promise.allSettled 保序收齐。
   * @param calls 全部工具调用（本批取 [from, to) 区间）。
   * @param from 批起始下标（含）。
   * @param to 批结束下标（不含）。
   * @param execute 单调用执行器。
   * @param results 结果写回数组（按下标就地填充，保证 model-order）。
   * @returns 无返回值。
   */
  private async runParallelBatch(
    calls: readonly ToolCall[],
    from: number,
    to: number,
    execute: ToolExecutor,
    results: (ScheduledResult | undefined)[],
  ): Promise<void> {
    let cursor = from;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(this.maxParallel, to - from); w++) {
      workers.push(
        (async () => {
          while (cursor < to) {
            const idx = cursor;
            cursor += 1;
            results[idx] = {
              call: ArrayAt.at(calls, idx),
              result: await ToolScheduler.safeExecute(ArrayAt.at(calls, idx), execute),
            };
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  /**
   * 保守内置判定：**写类（`MUTATING_TOOLS`）一律串行**；其余工具名含写类模式词亦串行。
   *
   * 2026-09-22 修（审计 P2）：原实现只看名字子串黑名单，于是 `rollback` / `checkpoint` / `remember`
   * 这类**不在黑名单但确实有副作用**的工具被判为可并行——实测 `rollback | read_file | remember`
   * 同批并发，与模块头「写类形成屏障」的契约直接矛盾，也与 `MUTATING_TOOLS` 口径漂移。
   * 现以 `MUTATING_TOOLS` 为**单一真相**，名字模式仅作未知/第三方工具的兜底。
   * @param toolName 工具名称
   * @returns 是否可并行（只读/无共享可变状态）
   */
  private static defaultParallelCapable(toolName: string): boolean {
    if (MUTATING_TOOLS.has(toolName)) {
      return false;
    }
    const lower = toolName.toLowerCase();
    return !SERIAL_PATTERNS.some((p) => lower.includes(p));
  }

  /**
   * 构造 failed ToolResult（工具执行抛异常时兜底，不连累同批其他调用）。
   * @param call 原工具调用（用于回填 callId）
   * @param err 捕获到的异常
   * @returns 转为失败的 ToolResult
   */
  private static failedResult(call: ToolCall, err: unknown): ToolResult {
    const message = err instanceof Error ? err.message : String(err);
    return { callId: call.id, ok: false, error: message };
  }

  /**
   * 安全执行单个工具调用：异常被捕获并转为 failed ToolResult（有界池工作协程专用）。
   * @param call 待执行的工具调用
   * @param execute 单调用执行器
   * @returns 执行结果或失败兜底结果
   */
  private static async safeExecute(call: ToolCall, execute: ToolExecutor): Promise<ToolResult> {
    try {
      return await execute(call);
    } catch (err) {
      return ToolScheduler.failedResult(call, err);
    }
  }
}
