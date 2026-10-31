/**
 * 回合中 steering 队列（2026-10-29，A8；2026-10-31 扩展为多模态队列项）。
 *
 * 只做「按会话入队/出队」，不写事件流——消费点必须在**步边界**（TurnRunner 下一步开始前），
 * 否则会插进 `assistant(tool_calls) <-> tool` 中间触发上游 400。
 *
 * 2026-10-31（插话模式）：队列项从「一段文本」升级为**与首条用户消息同构的载荷**
 * （文本 + images + files）。用户在任务进行中补发的图片 / 视频 / GIF / 文件 / 链接
 * 不再被丢弃：它们与文本一起在步边界作为一条完整的 user 消息注入，模型看到的内容
 * 与「正常发送」一致。
 */

import type { FileAttachment, ImageContent } from '../../ports/model/model.ts';

/** 一条待注入的插话（与 `turns.run` 的 prompt/images/files 同构）。 */
export interface SteeringItem {
  /** 追加指令文本（允许空串：纯附件补充）。 */
  readonly text: string;
  /** 图片/视频等图像内容（可选，随 user 消息送入模型）。 */
  readonly images?: readonly ImageContent[] | undefined;
  /** 任意文件附件（可选，随 user 消息送入模型）。 */
  readonly files?: readonly FileAttachment[] | undefined;
}

/**
 * 回合中 steering 队列。
 *
 * 语义保持 A8 的两条硬约束：
 * 1. **按会话隔离**（并发回合互不串话）；
 * 2. **只入队，不即时注入**（消费点由 TurnRunner 在步边界调用 `take`）。
 */
export class SteeringQueue {
  /** 每会话待注入项（插入序）。 */
  private readonly queues = new Map<string, SteeringItem[]>();

  /**
   * 入队一条 steering。
   * @param sessionId 目标会话。
   * @param item 追加内容（文本 + 可选附件）；文本与附件同时为空时忽略。
   * @returns 是否入队。
   */
  public enqueue(sessionId: string, item: SteeringItem | string): boolean {
    const normalized = typeof item === 'string' ? { text: item } : item;
    if (!SteeringQueue.hasContent(normalized)) return false;
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(normalized);
    this.queues.set(sessionId, queue);
    return true;
  }

  /**
   * 取走一条 steering。
   * @param sessionId 会话。
   * @returns 队列项；队列空时 undefined。
   */
  public take(sessionId: string): SteeringItem | undefined {
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

  /**
   * 清空某会话的待注入项（会话删除 / 用户停止后由调用方按需调用）。
   * @param sessionId 会话。
   * @returns 被清掉的条数。
   */
  public clear(sessionId: string): number {
    const queue = this.queues.get(sessionId);
    if (queue === undefined) return 0;
    this.queues.delete(sessionId);
    return queue.length;
  }

  /**
   * 队列项是否有可注入内容（纯文本或任一附件）。
   * @param item 队列项。
   * @returns 有内容为 true。
   */
  private static hasContent(item: SteeringItem): boolean {
    if (item.text.trim() !== '') return true;
    return (item.images?.length ?? 0) + (item.files?.length ?? 0) > 0;
  }
}
