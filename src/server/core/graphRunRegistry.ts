/**
 * 图运行台账（runId → 运行态 + 取消句柄）——从 `AppServer` 按职责缝抽出。
 *
 * 存在理由（两块，均来自 2026-09-26 审计）：
 *  1. **S20 有界保留**：`graphRuns` 原先只 `.set()` 从不删除，长跑 serve 里每条记录都持有节点
 *     状态与完整 blackboard ⇒ 无界增长。台账负责按插入序淘汰最旧一条。
 *  2. **F13 可取消**：`graph.run` 驱动的 `WorkflowRunner` 原先没传 signal，`isCancelled()` 恒假 ——
 *     会话 abort 后图内子步继续烧 token。台账按 runId 记账（含归属会话），使 `turns.abort` 能
 *     连带中止对应图运行。
 *
 * 顺带把这段逻辑移出 `AppServer`：它是「状态登记 + 淘汰 + 取消」，与 RPC 分发无关，混在一起只会
 * 把上帝类推过代码行阈值。
 */

import { Id } from '../../util/id.js';
import type { WorkflowDef } from '../../autonomy/workflowTypes.js';
import type { GraphRunState } from './appServerState.js';

/** 一次图运行的登记结果。 */
export interface GraphRunHandle {
  /** 本次运行标识（供 `graph.status` 与通知关联）。 */
  readonly runId: string;
  /** 可变运行态（节点状态由调用方的 onNodeUpdate 就更新）。 */
  readonly state: GraphRunState;
  /** 取消信号（透传给 `WorkflowRunner`）。 */
  readonly signal: AbortSignal;
}

/**
 * 图运行台账（无 IO、纯内存）。
 */
export class GraphRunRegistry {
  /**
   * 保留的运行态上限（超出即按插入序淘汰最旧一条）。
   *
   * 依据：`graph.status` 只服务于「刚刚发起的那次运行」，最近 50 条足够；上限存在的意义是
   * 把长跑 serve 的无界增长封死。
   */
  public static readonly MAX_RUNS = 50;

  /** 运行台账（插入序即发起序）。 */
  private readonly runs = new Map<string, GraphRunState>();
  /** 取消句柄（runId → 控制器 + 归属会话）。 */
  private readonly aborts = new Map<
    string,
    { readonly controller: AbortController; readonly threadId: string | undefined }
  >();

  /**
   * 登记一次新运行（建态、写入节点、淘汰最旧、登记取消句柄）。
   * @param def 图定义（调用方保证 `steps` 非空）。
   * @param defId 已存图 id（内联定义时为 undefined）。
   * @param owner 归属会话 id（无归属时 undefined）。
   * @returns 该次运行的句柄（runId / 可变状态 / 取消信号）。
   */
  public begin(
    def: WorkflowDef,
    defId: string | undefined,
    owner: string | undefined,
  ): GraphRunHandle {
    const runId = Id.id('run');
    const state: GraphRunState = {
      runId,
      defId,
      defName: def.name,
      nodes: {},
      done: false,
      startedAt: Date.now(),
    };
    for (const step of def.steps) {
      state.nodes[step.id] = { id: step.id, status: 'pending' };
    }
    this.runs.set(runId, state);
    while (this.runs.size > GraphRunRegistry.MAX_RUNS) {
      const oldest = this.runs.keys().next();
      if (oldest.done === true) break;
      this.runs.delete(oldest.value);
      this.aborts.delete(oldest.value);
    }
    const controller = new AbortController();
    this.aborts.set(runId, { controller, threadId: owner });
    return { runId, state, signal: controller.signal };
  }

  /**
   * 查询运行态。
   * @param runId 运行标识。
   * @returns 运行态；未知或已被淘汰时为 undefined。
   */
  public get(runId: string): GraphRunState | undefined {
    return this.runs.get(runId);
  }

  /**
   * 释放某次运行的取消句柄（运行结束时调用；运行态本身保留供 `graph.status` 查询）。
   * @param runId 运行标识。
   * @returns 无返回值。
   */
  public release(runId: string): void {
    this.aborts.delete(runId);
  }

  /**
   * 中止匹配的运行（`turns.abort` 的连带动作）。
   * @param threadId 目标会话 id；空串表示「全量中止」（旧前端不带参数的退化路径）。
   * @returns 被中止的运行数。
   */
  public abortMatching(threadId: string): number {
    let aborted = 0;
    for (const [runId, entry] of this.aborts) {
      if (threadId !== '' && entry.threadId !== threadId) continue;
      entry.controller.abort();
      this.aborts.delete(runId);
      aborted += 1;
    }
    return aborted;
  }
}
