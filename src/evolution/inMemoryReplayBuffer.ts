import type { CodeCandidate, ReplayBuffer } from './rlvrLoop.js';

/** 内存回放缓冲（带容量上限，超出按 FIFO 丢弃最旧）。 */
export class InMemoryReplayBuffer implements ReplayBuffer {
  private readonly items: { candidate: CodeCandidate; reward: number }[] = [];
  public constructor(private readonly capacity = 256) {}
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
