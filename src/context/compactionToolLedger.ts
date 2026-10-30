import type { ModelMessage } from '../ports/model/modelMessage.ts';

/**
 * 压缩摘要的**确定性工具台账**（2026-10-30 从 `ContextCompactor` 拆出；该文件长期贴行数上限）。
 *
 * 为什么需要：摘要由模型生成，长会话里它可能漏掉「已经读过哪些文件、跑过哪些命令」；
 * 一旦漏掉，模型下一步就会重新探索，形成「压缩 → 失忆 → 重复读」的循环（2026-10-13
 * `sess_mv88ycm7_1` 对同一文件 `read_file` 34 次）。台账直接由折叠段的 assistant(tool_calls)
 * 与 tool 结果配对生成，**不依赖摘要质量**，并按「工具 + 目标」聚合计数（×N）——重复本身
 * 也因此在上下文里可见。
 */
export class CompactionToolLedger {
  /**
   * 把台账追加到模型摘要之后（没有工具调用时原样返回摘要）。
   * @param summary 模型摘要。
   * @param head 被折叠的消息段。
   * @param budget 可用消息预算（过小则不加台账，避免挤掉 tail）。
   * @returns 摘要（无工具调用 / 预算过小时逐字不变）。
   */
  public static append(summary: string, head: readonly ModelMessage[], budget: number): string {
    if (budget < CompactionToolLedger.MIN_BUDGET_TOKENS) {
      return summary;
    }
    const ledger = CompactionToolLedger.lines(head);
    if (ledger.length === 0) {
      return summary;
    }
    return `${summary}\n\n## 已执行工具台账（确定性生成，用于避免重复探索）\n${ledger.join('\n')}`;
  }

  /**
   * 台账生效的最小消息预算（token）：低于此值时台账的收益不如「保住最近工具轮」大。
   * 生产压缩阈值是 0.8×窗口（128k → 102k），远高于此值。
   */
  private static readonly MIN_BUDGET_TOKENS = 2000;

  /**
   * 生成工具台账行（按「工具 + 目标」聚合，最多 40 行）。
   * @param head 被折叠的消息段。
   * @returns 台账行数组（按首次出现顺序）。
   */
  private static lines(head: readonly ModelMessage[]): string[] {
    const calls = new Map<string, { readonly name: string; readonly target: string }>();
    const stats = new Map<
      string,
      { readonly name: string; readonly target: string; count: number; fail: number }
    >();
    const order: string[] = [];
    for (const message of head) {
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        for (const call of message.toolCalls) {
          calls.set(call.id, {
            name: call.name,
            target: CompactionToolLedger.targetOf(call.arguments),
          });
        }
        continue;
      }
      if (message.role !== 'tool' || message.toolCallId === undefined) {
        continue;
      }
      const call = calls.get(message.toolCallId);
      if (call === undefined) {
        continue;
      }
      const key = `${call.name}\u0000${call.target}`;
      let entry = stats.get(key);
      if (entry === undefined) {
        entry = { name: call.name, target: call.target, count: 0, fail: 0 };
        stats.set(key, entry);
        order.push(key);
      }
      entry.count += 1;
      if (message.content.startsWith('工具执行失败')) {
        entry.fail += 1;
      }
    }
    return order.slice(0, 40).map((key) => {
      const entry = stats.get(key) as {
        readonly name: string;
        readonly target: string;
        count: number;
        fail: number;
      };
      const failed = entry.fail > 0 ? `（失败 ${String(entry.fail)} 次）` : '';
      const target = entry.target === '' ? '(无参数)' : entry.target;
      return `- ${entry.name} ${target} ×${String(entry.count)}${failed}`;
    });
  }

  /**
   * 台账里的「目标」：取命令/路径/模式/URL 之一，压成一行并截断。
   * @param args 工具参数。
   * @returns 可读目标（无可用字段为空串）。
   */
  private static targetOf(args: Record<string, unknown>): string {
    const raw = args['command'] ?? args['path'] ?? args['pattern'] ?? args['url'] ?? args['query'];
    if (typeof raw !== 'string') {
      return '';
    }
    const oneLine = raw.replace(/\s+/gu, ' ').trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }
}
