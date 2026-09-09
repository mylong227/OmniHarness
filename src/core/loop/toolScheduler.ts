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

import type { ToolCall, ToolResult } from '../../ports/tool.js';

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

/** 保守内置判定：名字含写类动词/写类工具名单则必须串行。 */
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

function defaultParallelCapable(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return !SERIAL_PATTERNS.some((p) => lower.includes(p));
}

/** failed ToolResult 兜底（工具执行抛异常时不连累同批其他调用）。 */
function failedResult(call: ToolCall, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { callId: call.id, ok: false, error: message };
}

export class ToolScheduler {
  private readonly maxParallel: number;
  private readonly parallelCapable: (toolName: string) => boolean;

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxParallel = Math.max(1, options.maxParallel ?? 8);
    this.parallelCapable = options.parallelCapable ?? defaultParallelCapable;
  }

  /**
   * 调度执行一批工具调用：连续并行安全调用并行化（有界池），写类形成屏障串行。
   * 返回结果与输入同序（model-order），上层按序记录即可。
   */
  async run(calls: readonly ToolCall[], execute: ToolExecutor): Promise<readonly ScheduledResult[]> {
    const results = new Array<ScheduledResult | undefined>(calls.length);
    let i = 0;
    while (i < calls.length) {
      if (this.parallelCapable(calls[i]!.name)) {
        // 收集连续的并行安全调用为一批（有界：批内再按 maxParallel 滚动并发）。
        let j = i;
        while (j < calls.length && this.parallelCapable(calls[j]!.name)) {
          j += 1;
        }
        await this.runParallelBatch(calls, i, j, execute, results);
        i = j;
      } else {
        // 屏障：此刻必然没有在飞任务（并行批已在上方 await 排空），直接串行执行。
        results[i] = { call: calls[i]!, result: await safeExecute(calls[i]!, execute) };
        i += 1;
      }
    }
    return results.map((r, idx) => r ?? { call: calls[idx]!, result: failedResult(calls[idx]!, new Error('调度遗漏')) });
  }

  /** 有界并发执行 [from, to) 区间的并行安全调用；Promise.allSettled 保序收齐。 */
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
            results[idx] = { call: calls[idx]!, result: await safeExecute(calls[idx]!, execute) };
          }
        })(),
      );
    }
    await Promise.all(workers);
  }
}

async function safeExecute(call: ToolCall, execute: ToolExecutor): Promise<ToolResult> {
  try {
    return await execute(call);
  } catch (err) {
    return failedResult(call, err);
  }
}
