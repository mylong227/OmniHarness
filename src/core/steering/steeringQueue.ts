/**
 * 回合中 steering 队列（2026-10-29，A8）。
 *
 * 只做「按会话入队/出队」，不写事件流——消费点必须在**步边界**（TurnRunner 下一步开始前），
 * 否则会插进 `assistant(tool_calls) <-> tool` 中间触发上游 400。
 */
export class SteeringQueue {
  /** 每会话待注入文本（插入序）。 */
  private readonly queues = new Map<string, string[]>();

  /**
   * 入队一条 steering。
   * @param sessionId 目标会话。
   * @param text 文本（去首尾空白；空串忽略）。
   * @returns 是否入队。
   */
  public enqueue(sessionId: string, text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === '') return false;
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(trimmed);
    this.queues.set(sessionId, queue);
    return true;
  }

  /**
   * 取走一条 steering。
   * @param sessionId 会话。
   * @returns 文本；队列空时 undefined。
   */
  public take(sessionId: string): string | undefined {
    const queue = this.queues.get(sessionId);
    const next = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.queues.delete(sessionId);
    return next;
  }

  /**
   * 待注入条数（观测/测试用）。
   * @param sessionId 会话。
   * @returns 条数。
   */
  public size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }
}
