// 2026-10-27 环④拆解：契约类型一律直连端口层（`ReplayBuffer` 已从 `rlvrLoop.ts` 外迁
// `ports/runtime/evolution/replayBuffer.ts`）——反向 import 实现文件会复活 2 成员环。
import type { CodeCandidate } from '../ports/runtime/evolution/codeCandidate.ts';
import type { ReplayBuffer } from '../ports/runtime/evolution/replayBuffer.ts';

/** 内存回放缓冲（带容量上限，超出按 FIFO 丢弃最旧）。 */
export class InMemoryReplayBuffer implements ReplayBuffer {
  private readonly items: { candidate: CodeCandidate; reward: number }[] = [];
  public constructor(private readonly capacity = 256) {}
  /**
   * 追加一条绿样本；超出容量（默认 256）时按 FIFO 丢弃最旧条目。
   * @param candidate 通过可验证奖励筛选的代码候选
   * @param reward 该候选的奖励得分（供后续策略更新/回放消费）
   
   * @returns 无返回值。
   */
  public push(candidate: CodeCandidate, reward: number): void {
    this.items.push({ candidate, reward });
    while (this.items.length > this.capacity) this.items.shift();
  }
  public get size(): number {
    return this.items.length;
  }
  public get entries(): readonly { candidate: CodeCandidate; reward: number }[] {
    return this.items;
  }
}
