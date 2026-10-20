import type { SessionEvent } from '../ports/runtime/event.ts';

/** 证据账本摘要（VER-02）。 */
export interface EvidenceSummary {
  /** 本回合是否发起过工具调用。 */
  readonly hasToolCalls: boolean;
  /** 本回合是否有成功的工具结果。 */
  readonly hasSuccessfulTool: boolean;
  /** 本回合是否产生了任何工具结果（没有结果时无法判断“全失败”）。 */
  readonly hasToolResults: boolean;
  /** 成功工具名（去重、按出现顺序）。 */
  readonly successfulTools: readonly string[];
  /** 失败工具结果条数。 */
  readonly failedTools: number;
}

/**
 * 证据账本（VER-02，2026-10-20）。
 *
 * 口径刻意保守：只把“本回合成功的工具结果”算证据；纯问答（没有工具调用）不惩罚；
 * 有工具调用但全部失败时，模型仍可给出文本，但完成状态不能是 `passed`。
 * 它不是“任务成功”的证明，只是“至少有一个可复核动作”的下限证据。
 */
export class EvidenceLedger {
  /**
   * 从本回合事件生成摘要。
   * @param events 本回合事件。
   * @returns 摘要。
   */
  public static summarize(events: readonly SessionEvent[]): EvidenceSummary {
    const calls = new Map<string, string>();
    for (const event of events) {
      if (event.type !== 'tool_call') continue;
      const payload = event.payload as { callId?: string; name?: string };
      if (payload.callId !== undefined && payload.name !== undefined) {
        calls.set(payload.callId, payload.name);
      }
    }
    const successful = new Set<string>();
    let failedTools = 0;
    for (const event of events) {
      if (event.type !== 'tool_result') continue;
      const payload = event.payload as { callId?: string; ok?: boolean };
      if (payload.ok === true) {
        const name = payload.callId === undefined ? undefined : calls.get(payload.callId);
        if (name !== undefined) successful.add(name);
      } else {
        failedTools += 1;
      }
    }
    return {
      hasToolCalls: calls.size > 0,
      hasSuccessfulTool: successful.size > 0,
      hasToolResults: failedTools + successful.size > 0,
      successfulTools: [...successful],
      failedTools,
    };
  }

  /**
   * 本回合是否有“至少一条成功工具”的证据。
   *
   * 纯问答（无工具调用）返回 true（不惩罚没有工具的任务）；有工具调用但全部失败返回 false。
   * @param events 本回合事件。
   * @returns 可作为完成证据时为 true。
   */
  public static hasCompletionEvidence(events: readonly SessionEvent[]): boolean {
    const summary = EvidenceLedger.summarize(events);
    // 没有工具结果时无法判断（例如只记录调用的轻量 step runner）=> 不惩罚；
    // 有结果但全部失败 => 明确没有证据。
    return !summary.hasToolResults || summary.hasSuccessfulTool;
  }
}
