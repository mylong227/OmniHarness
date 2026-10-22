import type { SessionEvent } from '../ports/runtime/event.ts';

/**
 * 跨工具来源追踪（SEC-03，2026-10-20）。
 *
 * 目标不是完整 CaMeL，而是一条**可复核的下限**：把外部不可信工具输出里的若干片段记下来；
 * 当模型把同一片段塞进写类工具参数时，`StepToolExecutor` 可以（显式开启后）拒绝，
 * 阻止“读到注入内容 → 原样写进文件/命令”的最短外泄路径。
 *
 * 边界：这是**字符串片段匹配**，不是数据流分析；会漏（改写/编码）也会误报（正常引用同一段文本）。
 * 因此默认关闭，只由 `OMNI_PROVENANCE_GUARD=shadow|enforce` 开启
 * （`shadow` 只记录本该拦截的证据、原样放行；`enforce` 才拒绝），并在拒绝原因里写清依据。
 */
export class ProvenanceTracker {
  /** 需要视为不可信来源的工具名前缀/精确名。 */
  private static readonly UNTRUSTED_TOOLS: ReadonlySet<string> = new Set([
    'web_fetch',
    'web_search',
  ]);

  /** 片段集合（去重；每段最多 240 字符，最多 64 段，避免无界增长）。 */
  private readonly snippets = new Set<string>();

  /**
   * 从历史事件构造 tracker（只读）。
   * @param events 会话事件。
   * @returns tracker。
   */
  public static fromEvents(events: readonly SessionEvent[]): ProvenanceTracker {
    const tracker = new ProvenanceTracker();
    const names = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'tool_call') {
        const payload = event.payload as { callId?: string; name?: string };
        if (payload.callId !== undefined && payload.name !== undefined) {
          names.set(payload.callId, payload.name);
        }
      }
    }
    for (const event of events) {
      if (event.type !== 'tool_result') continue;
      const payload = event.payload as { callId?: string; ok?: boolean; output?: string };
      if (payload.ok !== true || typeof payload.output !== 'string') continue;
      const name = payload.callId === undefined ? undefined : names.get(payload.callId);
      if (name === undefined) continue;
      if (!ProvenanceTracker.UNTRUSTED_TOOLS.has(name) && !name.startsWith('mcp_')) continue;
      tracker.observe(payload.output);
    }
    return tracker;
  }

  /**
   * 记录一段不可信内容（截断到 240 字符；过短片段不记，避免误报）。
   * @param text 工具输出。
   * @returns 无返回值。
   */
  public observe(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length < 20) return;
    this.snippets.add(trimmed.slice(0, 240));
    if (this.snippets.size > 64) {
      const first = this.snippets.values().next().value;
      if (first !== undefined) this.snippets.delete(first);
    }
  }

  /**
   * 参数里是否出现不可信片段。
   * @param args 工具参数。
   * @returns 命中时为 true。
   */
  public isTainted(args: unknown): boolean {
    if (this.snippets.size === 0) return false;
    const text = typeof args === 'string' ? args : JSON.stringify(args);
    for (const snippet of this.snippets) {
      if (text.includes(snippet)) return true;
    }
    return false;
  }
}
