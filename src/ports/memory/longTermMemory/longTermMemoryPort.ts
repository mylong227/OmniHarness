import type { MemoryFact } from './memoryFact.js';
import type { MemoryFactPatch } from './memoryFactPatch.js';

/**
 * 长期记忆端口：跨会话持久化的「durable fact」存储与召回。
 *
 * 与 #M2 `RetrievalPort`（内存会话检索，进程退出即丢）本质不同：
 * 这里存的是从对话中蒸馏出的、可跨会话复用的**持久事实**，落盘存活，
 * 使 harness 真正"记得"用户偏好、项目约定、关键决策、踩过的坑。
 */
export interface LongTermMemoryPort {
  readonly name: string;
  /** 写入一条持久事实。 */
  remember(fact: MemoryFact): void;
  /** 按自然语言召回 top-k 事实（BM25，跨全部会话）。 */
  recall(query: string, k: number): readonly MemoryFact[];
  /** 全部事实（导出/调试）。 */
  all(): readonly MemoryFact[];
  /** 事实总数。 */
  readonly count: number;
  /** 按 ID 取单条事实（管理 UI 编辑用）。 */
  get(id: string): MemoryFact | undefined;
  /** 编辑一条事实（管理 UI 用）；成功返回 true。 */
  update(id: string, patch: MemoryFactPatch): boolean;
  /**
   * 批量编辑（可选能力）：一次性应用多条补丁，**实现应只落盘一次**。
   *
   * 存在理由（2026-09-26 审计 S13）：退火器一步会更新上千条事实的重要性，而 `update` 每次都做
   * 「整文件重写 + 重加密」⇒ O(n²) 的同步 IO 直接阻塞事件循环。提供批量入口后，退火一步只落盘一次。
   * 实现方若未提供（旧实现/内存实现），调用方按 `update` 逐条回落 —— 契约向后兼容。
   * @param patches 待应用的补丁列表。
   * @returns 实际被修改的条数（未命中的 id 不计）。
   */
  updateMany?(patches: readonly { readonly id: string; readonly patch: MemoryFactPatch }[]): number;
  /** 删除一条事实（管理 UI 用）；成功返回 true。 */
  delete(id: string): boolean;
}
